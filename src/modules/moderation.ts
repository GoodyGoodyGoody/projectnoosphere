import { requireScope, type Actor } from "../auth.ts";
import type { DB } from "../db.ts";
import { conflict, notFound } from "../errors.ts";
import { newId } from "../ids.ts";
import { nowIso } from "../time.ts";

// Moderation changes review state and the published pointer — never content.
// Every decision is an append-only moderation_events row written in the same
// transaction as the change it records. Callers need the 'moderate' scope,
// which only stewards can hold (a steward may be the librarian bot, ADR 0005).

function recordEvent(
  db: DB,
  actor: Actor,
  targetType: "revision" | "annotation",
  targetId: string,
  action: string,
  reason: string,
  at: string,
): string {
  const id = newId("mod");
  db.prepare(
    `INSERT INTO moderation_events (id, actor_id, target_type, target_id, action, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, actor.contributorId, targetType, targetId, action, reason, at);
  return id;
}

// Publication is a compare-and-set on the record's pointer: it succeeds only if
// the pointer still equals the candidate's base. A candidate proposed against an
// older base must be re-proposed against the current revision and reviewed again.
export function publishRevision(db: DB, actor: Actor, revisionId: string, reason: string) {
  requireScope(actor, "moderate");
  return db
    .transaction(() => {
      const rev = db
        .prepare(
          `SELECT v.record_id, v.base_revision_id, rr.state
             FROM revisions v JOIN revision_review rr ON rr.revision_id = v.id WHERE v.id = ?`,
        )
        .get(revisionId) as { record_id: string; base_revision_id: string | null; state: string } | undefined;
      if (!rev) throw notFound("revision");
      if (rev.state !== "candidate") {
        throw conflict("not_candidate", `only a candidate can be published (this one is ${rev.state})`, {
          review_state: rev.state,
        });
      }
      const now = nowIso();
      const swapped = db
        .prepare(
          `UPDATE records SET current_revision_id = ?, updated_at = ?
            WHERE id = ? AND current_revision_id IS ?`,
        )
        .run(revisionId, now, rev.record_id, rev.base_revision_id);
      if (swapped.changes !== 1) {
        const current = db.prepare("SELECT current_revision_id FROM records WHERE id = ?").pluck().get(rev.record_id);
        throw conflict("stale_base", "the record moved on since this candidate was proposed; it must be re-proposed", {
          current_revision_id: current,
          candidate_base_revision_id: rev.base_revision_id,
        });
      }
      db.prepare("UPDATE revision_review SET state = 'reviewed', reason = ?, updated_at = ? WHERE revision_id = ?")
        .run(reason, now, revisionId);
      const eventId = recordEvent(db, actor, "revision", revisionId, "publish_revision", reason, now);
      return {
        event_id: eventId,
        record_id: rev.record_id,
        published_revision_id: revisionId,
        previous_revision_id: rev.base_revision_id,
      };
    })
    .immediate();
}

export function approveAnnotation(db: DB, actor: Actor, annotationId: string, reason: string) {
  requireScope(actor, "moderate");
  return db
    .transaction(() => {
      const row = db.prepare("SELECT state FROM annotation_review WHERE annotation_id = ?").get(annotationId) as
        | { state: string }
        | undefined;
      if (!row) throw notFound("annotation");
      if (row.state !== "candidate") {
        throw conflict("not_candidate", `only a candidate can be approved (this one is ${row.state})`, {
          review_state: row.state,
        });
      }
      const now = nowIso();
      db.prepare("UPDATE annotation_review SET state = 'reviewed', reason = ?, updated_at = ? WHERE annotation_id = ?")
        .run(reason, now, annotationId);
      const eventId = recordEvent(db, actor, "annotation", annotationId, "approve_annotation", reason, now);
      return { event_id: eventId, annotation_id: annotationId, review_state: "reviewed" };
    })
    .immediate();
}

// A steward revoking another contributor's credential (the ban path, charter
// ladder). Logged like every other moderation decision.
export function revokeCredentialAsSteward(db: DB, actor: Actor, tokenPrefix: string, reason: string) {
  requireScope(actor, "moderate");
  return db
    .transaction(() => {
      const cred = db.prepare("SELECT id, revoked_at FROM credentials WHERE token_prefix = ?").get(tokenPrefix) as
        | { id: string; revoked_at: string | null }
        | undefined;
      if (!cred) throw notFound("credential");
      if (cred.revoked_at) throw conflict("already_revoked", "this credential is already revoked");
      const now = nowIso();
      db.prepare("UPDATE credentials SET revoked_at = ? WHERE id = ?").run(now, cred.id);
      const id = newId("mod");
      db.prepare(
        `INSERT INTO moderation_events (id, actor_id, target_type, target_id, action, reason, created_at)
         VALUES (?, ?, 'credential', ?, 'revoke_credential', ?, ?)`,
      ).run(id, actor.contributorId, cred.id, reason, now);
      return { event_id: id, token_prefix: tokenPrefix, revoked_at: now };
    })
    .immediate();
}
