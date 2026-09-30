import type { Actor } from "../auth.ts";
import type { DB } from "../db.ts";
import { invalid, notFound } from "../errors.ts";
import { annotationHash, ANNOTATION_HASH_SCHEMA } from "../hash.ts";
import { newId } from "../ids.ts";
import { LIMITS, type AnnotationInput, type SourceRef } from "../schemas.ts";
import { nowIso } from "../time.ts";

// Every annotation targets one exact revision, fixed at creation. A report that
// something "worked" on revision 1 never becomes a report about revision 4.

function checkAnnotationInput(db: DB, actor: Actor, revisionId: string, input: AnnotationInput) {
  if (input.kind === "outcome_report") {
    if (!input.outcome) throw invalid("outcome", "an outcome report needs an outcome");
    // Enough detail to tell an observation from a bare endorsement.
    if (input.body.trim().length < LIMITS.outcomeReportMinBody) {
      throw invalid(
        "body",
        `describe what you did and observed (at least ${LIMITS.outcomeReportMinBody} characters)`,
      );
    }
    if (Object.keys(input.conditions ?? {}).length === 0) {
      throw invalid("conditions", "say where you tested it (software versions, OS, date, ...)");
    }
  } else if (input.outcome !== undefined) {
    throw invalid("outcome", "only an outcome_report carries an outcome");
  }

  const exists = db.prepare("SELECT 1 FROM revisions WHERE id = ?");
  (input.evidence ?? []).forEach((ref, i) => {
    if (ref.revision_id && !exists.get(ref.revision_id)) {
      throw invalid(`evidence[${i}].revision_id`, "no such revision");
    }
  });

  if (input.supersedes_annotation_id) {
    const own = db
      .prepare("SELECT 1 FROM annotations WHERE id = ? AND revision_id = ? AND author_id = ?")
      .get(input.supersedes_annotation_id, revisionId, actor.contributorId);
    if (!own) {
      throw invalid(
        "supersedes_annotation_id",
        "must name your own earlier annotation on this same revision",
      );
    }
  }
}

export function createAnnotation(
  db: DB,
  actor: Actor,
  revisionId: string,
  input: AnnotationInput,
): { annotationId: string } {
  const target = db
    .prepare(
      `SELECT rr.state FROM revisions v JOIN revision_review rr ON rr.revision_id = v.id
        WHERE v.id = ?`,
    )
    .get(revisionId) as { state: string } | undefined;
  // A quarantined revision is withheld everywhere; it does not take new reports.
  if (!target || target.state === "quarantined") throw notFound("revision");
  checkAnnotationInput(db, actor, revisionId, input);

  return db
    .transaction(() => {
      const fields = {
        id: newId("ann"),
        revision_id: revisionId,
        author_id: actor.contributorId,
        kind: input.kind,
        outcome: input.outcome ?? null,
        body: input.body,
        evidence: input.evidence ?? [],
        conditions: input.conditions ?? {},
        supersedes_annotation_id: input.supersedes_annotation_id ?? null,
        created_at: nowIso(),
      };
      db.prepare(
        `INSERT INTO annotations (id, revision_id, author_id, kind, outcome, body, evidence,
           conditions, supersedes_annotation_id, hash_schema, content_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        fields.id, fields.revision_id, fields.author_id, fields.kind, fields.outcome,
        fields.body, JSON.stringify(fields.evidence), JSON.stringify(fields.conditions),
        fields.supersedes_annotation_id, ANNOTATION_HASH_SCHEMA, annotationHash(fields),
        fields.created_at,
      );
      db.prepare(
        `INSERT INTO annotation_review (annotation_id, state, reason, updated_at)
         VALUES (?, 'candidate', NULL, ?)`,
      ).run(fields.id, fields.created_at);
      return { annotationId: fields.id };
    })
    .immediate();
}

interface AnnotationRow {
  id: string;
  revision_id: string;
  author_id: string;
  author_display_name: string;
  kind: string;
  outcome: string | null;
  body: string;
  evidence: string;
  conditions: string;
  supersedes_annotation_id: string | null;
  hash_schema: string;
  content_hash: string;
  created_at: string;
  review_state: string;
}

const ANNOTATION_SELECT = `
  SELECT a.*, p.display_name AS author_display_name, ar.state AS review_state
    FROM annotations a
    JOIN contributors p ON p.id = a.author_id
    JOIN annotation_review ar ON ar.annotation_id = a.id`;

export function annotationView(row: AnnotationRow) {
  return {
    id: row.id,
    revision_id: row.revision_id,
    review_state: row.review_state,
    author_id: row.author_id,
    author_display_name: row.author_display_name,
    kind: row.kind,
    outcome: row.outcome,
    body: row.body,
    evidence: JSON.parse(row.evidence) as SourceRef[],
    conditions: JSON.parse(row.conditions) as Record<string, unknown>,
    supersedes_annotation_id: row.supersedes_annotation_id,
    hash_schema: row.hash_schema,
    content_hash: row.content_hash,
    created_at: row.created_at,
  };
}

export function getAnnotation(db: DB, annotationId: string) {
  const row = db.prepare(`${ANNOTATION_SELECT} WHERE a.id = ?`).get(annotationId) as
    | AnnotationRow
    | undefined;
  if (!row) throw notFound("annotation");
  return annotationView(row);
}

// Ordinary output shows reviewed annotations. Candidates appear only when the
// caller asks for them explicitly, and each item carries its review_state.
// Quarantined, rejected and superseded annotations never appear here.
export function listAnnotations(
  db: DB,
  revisionId: string,
  opts: { limit: number; cursor?: string; includeCandidate: boolean },
) {
  const state = db
    .prepare("SELECT state FROM revision_review WHERE revision_id = ?")
    .get(revisionId) as { state: string } | undefined;
  if (!state || state.state === "quarantined") throw notFound("revision");

  const states = opts.includeCandidate ? ["reviewed", "candidate"] : ["reviewed"];
  const rows = db
    .prepare(
      `${ANNOTATION_SELECT}
        WHERE a.revision_id = ? AND a.id > ?
          AND ar.state IN (SELECT value FROM json_each(?))
        ORDER BY a.id LIMIT ?`,
    )
    .all(revisionId, opts.cursor ?? "", JSON.stringify(states), opts.limit + 1) as AnnotationRow[];
  const more = rows.length > opts.limit;
  const items = rows.slice(0, opts.limit);
  return {
    revision_id: revisionId,
    included_states: states,
    items: items.map(annotationView),
    next_cursor: more ? (items.at(-1)?.id ?? null) : null,
  };
}
