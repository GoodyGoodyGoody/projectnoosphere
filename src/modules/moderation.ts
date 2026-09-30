import { requireScope, type Actor } from "../auth.ts";
import type { DB } from "../db.ts";
import { ApiError, conflict, notFound } from "../errors.ts";
import { findSecret } from "../gate.ts";
import { newId } from "../ids.ts";
import type { ModerationAction } from "../schemas.ts";
import { nowIso } from "../time.ts";
import { uniqueSlug } from "./records.ts";

// Moderation changes review state and the published pointer — never content.
// Every decision is an append-only moderation_events row written in the same
// transaction as the change it records, and is public. Callers need the
// 'moderate' scope, which only stewards can hold. In production the steward is
// the librarian bot (ADR 0005), acting through this API with its own key.

// Reasons are public. A reason must never republish a secret, even quoted.
function publicReason(reason: string): string {
  return findSecret(reason) ? "[reason withheld: it appeared to contain a credential]" : reason;
}

function recordEvent(
  db: DB,
  actor: Actor,
  targetType: "revision" | "annotation" | "credential",
  targetId: string,
  action: string,
  reason: string,
  at: string,
  rubricVersion: string | null = null,
): string {
  const id = newId("mod");
  db.prepare(
    `INSERT INTO moderation_events (id, actor_id, target_type, target_id, action, reason, created_at, rubric_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, actor.contributorId, targetType, targetId, action, publicReason(reason), at, rubricVersion);
  return id;
}

interface RevisionState {
  record_id: string;
  base_revision_id: string | null;
  state: string;
  title: string;
}

function revisionState(db: DB, revisionId: string): RevisionState {
  const rev = db
    .prepare(
      `SELECT v.record_id, v.base_revision_id, rr.state, v.title
         FROM revisions v JOIN revision_review rr ON rr.revision_id = v.id WHERE v.id = ?`,
    )
    .get(revisionId) as RevisionState | undefined;
  if (!rev) throw notFound("revision");
  return rev;
}

function requireState(kind: string, state: string, allowed: string[]): void {
  if (!allowed.includes(state)) {
    throw conflict("invalid_state", `cannot do this to a ${kind} that is ${state}`, { review_state: state });
  }
}

// Publication is a compare-and-set on the record's pointer: it succeeds only if
// the pointer still equals the candidate's base. A candidate proposed against an
// older base must be re-proposed against the current revision and reviewed again.
// A record's first publication also mints its permanent slug, from the title
// that was just reviewed.
export function publishRevision(db: DB, actor: Actor, revisionId: string, reason: string, rubricVersion: string | null = null) {
  requireScope(actor, "moderate");
  return db
    .transaction(() => {
      const rev = revisionState(db, revisionId);
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
      const minted = db.prepare("SELECT slug_minted_at FROM records WHERE id = ?").pluck().get(rev.record_id);
      if (minted === null) {
        db.prepare("UPDATE records SET slug = ?, slug_minted_at = ? WHERE id = ?")
          .run(uniqueSlug(db, rev.title, rev.record_id), now, rev.record_id);
      }
      db.prepare("UPDATE revision_review SET state = 'reviewed', reason = ?, updated_at = ? WHERE revision_id = ?")
        .run(publicReason(reason), now, revisionId);
      const eventId = recordEvent(db, actor, "revision", revisionId, "publish_revision", reason, now, rubricVersion);
      const slug = db.prepare("SELECT slug FROM records WHERE id = ?").pluck().get(rev.record_id);
      return {
        event_id: eventId,
        record_id: rev.record_id,
        record_slug: slug,
        published_revision_id: revisionId,
        previous_revision_id: rev.base_revision_id,
      };
    })
    .immediate();
}

export function approveAnnotation(db: DB, actor: Actor, annotationId: string, reason: string, rubricVersion: string | null = null) {
  requireScope(actor, "moderate");
  return db
    .transaction(() => {
      const state = annotationState(db, annotationId);
      if (state !== "candidate") {
        throw conflict("not_candidate", `only a candidate can be approved (this one is ${state})`, { review_state: state });
      }
      const now = nowIso();
      db.prepare("UPDATE annotation_review SET state = 'reviewed', reason = ?, updated_at = ? WHERE annotation_id = ?")
        .run(publicReason(reason), now, annotationId);
      const eventId = recordEvent(db, actor, "annotation", annotationId, "approve_annotation", reason, now, rubricVersion);
      return { event_id: eventId, annotation_id: annotationId, review_state: "reviewed" };
    })
    .immediate();
}

function annotationState(db: DB, annotationId: string): string {
  const state = db.prepare("SELECT state FROM annotation_review WHERE annotation_id = ?").pluck().get(annotationId) as
    | string
    | undefined;
  if (!state) throw notFound("annotation");
  return state;
}

// The remaining state changes, one rule table. `hold_*` changes nothing but
// records the decision (and its rubric version) publicly, so a held item is
// not re-reviewed until the rubric changes or someone appeals.
const TRANSITIONS: Record<string, { target: "revision" | "annotation"; from: string[]; to: string | null }> = {
  reject_revision: { target: "revision", from: ["candidate"], to: "rejected" },
  reject_annotation: { target: "annotation", from: ["candidate"], to: "rejected" },
  quarantine_revision: { target: "revision", from: ["candidate", "reviewed", "rejected", "superseded"], to: "quarantined" },
  quarantine_annotation: { target: "annotation", from: ["candidate", "reviewed", "rejected", "superseded"], to: "quarantined" },
  supersede_revision: { target: "revision", from: ["candidate"], to: "superseded" },
  hold_revision: { target: "revision", from: ["candidate"], to: null },
  hold_annotation: { target: "annotation", from: ["candidate"], to: null },
};

export function moderate(
  db: DB,
  actor: Actor,
  input: { action: ModerationAction; target_id: string; reason: string; rubric_version?: string },
) {
  requireScope(actor, "moderate");
  const rubric = input.rubric_version ?? null;
  if (input.action === "publish_revision") return publishRevision(db, actor, input.target_id, input.reason, rubric);
  if (input.action === "approve_annotation") return approveAnnotation(db, actor, input.target_id, input.reason, rubric);
  const rule = TRANSITIONS[input.action];
  if (!rule) throw new ApiError(400, "invalid_request", `unknown action ${input.action}`);
  return db
    .transaction(() => {
      const now = nowIso();
      if (rule.target === "revision") {
        const rev = revisionState(db, input.target_id);
        requireState("revision", rev.state, rule.from);
        if (input.action === "supersede_revision") {
          // Only a candidate whose base is no longer current can be superseded:
          // it lost a race and must be re-proposed. A deterministic decision,
          // never a model's.
          const current = db.prepare("SELECT current_revision_id FROM records WHERE id = ?").pluck().get(rev.record_id);
          if (current === rev.base_revision_id) {
            throw conflict("base_is_current", "this candidate's base is still current; it can be published or rejected, not superseded");
          }
        }
        if (rule.to) {
          db.prepare("UPDATE revision_review SET state = ?, reason = ?, updated_at = ? WHERE revision_id = ?")
            .run(rule.to, publicReason(input.reason), now, input.target_id);
        }
      } else {
        requireState("annotation", annotationState(db, input.target_id), rule.from);
        if (rule.to) {
          db.prepare("UPDATE annotation_review SET state = ?, reason = ?, updated_at = ? WHERE annotation_id = ?")
            .run(rule.to, publicReason(input.reason), now, input.target_id);
        }
      }
      const eventId = recordEvent(db, actor, rule.target, input.target_id, input.action, input.reason, now, rubric);
      return { event_id: eventId, target_id: input.target_id, action: input.action, ...(rule.to ? { review_state: rule.to } : {}) };
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
      const id = recordEvent(db, actor, "credential", cred.id, "revoke_credential", reason, now);
      return { event_id: id, token_prefix: tokenPrefix, revoked_at: now };
    })
    .immediate();
}
