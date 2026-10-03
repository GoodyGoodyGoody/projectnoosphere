import type { Actor } from "../auth.ts";
import type { DB } from "../db.ts";
import { invalid, notFound } from "../errors.ts";
import { refuseSecrets, scanFlags, type GateFlag } from "../gate.ts";
import { annotationHash, ANNOTATION_HASH_SCHEMA } from "../hash.ts";
import { newId } from "../ids.ts";
import { LIMITS, OUTCOMES_NEEDING_CHECK, type AnnotationInput, type OutcomeCheck, type SourceRef } from "../schemas.ts";
import { nowIso } from "../time.ts";

// Every annotation targets one exact revision, fixed at creation. A report that
// something "worked" on revision 1 never becomes a report about revision 4.

// "It exited 0" shows that a command ran, not that the result is right. A
// check's observed text must say what the check showed.
const BARE_SUCCESS =
  /^(?:(?:exit(?:ed)?|return(?:ed)?|rc|status|code)(?: with)?(?: (?:code|status))?\s*[:=]?\s*0|0|ok|okay|success(?:ful)?|succeeded|pass(?:ed)?|done|works|worked|it worked|fine|no errors?)$/i;
export function isBareSuccess(observed: string): boolean {
  return BARE_SUCCESS.test(observed.trim().replace(/^["'`]+|["'`.!\s]+$/g, ""));
}

function checkTexts(check: OutcomeCheck | undefined): Record<string, string> {
  return check ? { "check.ran": check.ran, "check.observed": check.observed } : {};
}

function checkAnnotationInput(db: DB, actor: Actor, revisionId: string, input: AnnotationInput): GateFlag[] {
  const texts: Record<string, string> = { body: input.body };
  (input.evidence ?? []).forEach((e, i) => {
    texts[`evidence[${i}].note`] = e.note;
    if (e.url) texts[`evidence[${i}].url`] = e.url;
    if (e.title) texts[`evidence[${i}].title`] = e.title;
  });
  for (const [k, v] of Object.entries(input.conditions ?? {})) texts[`conditions.${k}`] = String(v);
  Object.assign(texts, checkTexts(input.check));
  refuseSecrets(texts);
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
    if (!input.check && OUTCOMES_NEEDING_CHECK.includes(input.outcome)) {
      throw invalid(
        "check",
        "say how you confirmed it: check.ran is what you ran or inspected to confirm the result, " +
          "check.observed is what it showed",
      );
    }
    if (input.check && isBareSuccess(input.check.observed)) {
      throw invalid("check.observed", "say what the check showed, not only that it succeeded: an exit code alone does not show the result");
    }
  } else if (input.outcome !== undefined) {
    throw invalid("outcome", "only an outcome_report carries an outcome");
  } else if (input.check !== undefined) {
    throw invalid("check", "only an outcome_report carries a check");
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
  return scanFlags({ body: input.body, ...checkTexts(input.check) });
}

export function createAnnotation(
  db: DB,
  actor: Actor,
  revisionId: string,
  input: AnnotationInput,
): { annotationId: string; flags: GateFlag[] } {
  const target = db
    .prepare(
      `SELECT rr.state FROM revisions v JOIN revision_review rr ON rr.revision_id = v.id
        WHERE v.id = ?`,
    )
    .get(revisionId) as { state: string } | undefined;
  // A quarantined revision is withheld everywhere; it does not take new reports.
  if (!target || target.state === "quarantined") throw notFound("revision");
  const flags = checkAnnotationInput(db, actor, revisionId, input);

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
        check: input.check ? { ran: input.check.ran, observed: input.check.observed } : null,
        supersedes_annotation_id: input.supersedes_annotation_id ?? null,
        created_at: nowIso(),
      };
      db.prepare(
        `INSERT INTO annotations (id, revision_id, author_id, kind, outcome, body, evidence,
           conditions, check_json, supersedes_annotation_id, hash_schema, content_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        fields.id, fields.revision_id, fields.author_id, fields.kind, fields.outcome,
        fields.body, JSON.stringify(fields.evidence), JSON.stringify(fields.conditions),
        fields.check ? JSON.stringify(fields.check) : null,
        fields.supersedes_annotation_id, ANNOTATION_HASH_SCHEMA, annotationHash(fields),
        fields.created_at,
      );
      db.prepare(
        `INSERT INTO annotation_review (annotation_id, state, reason, updated_at, gate_flags)
         VALUES (?, 'candidate', NULL, ?, ?)`,
      ).run(fields.id, fields.created_at, JSON.stringify(flags));
      return { annotationId: fields.id, flags };
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
  check_json: string | null;
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
    // null on reports written before checks existed (hash schema /1), and on
    // not_applicable / inconclusive reports that did not give one.
    check: row.check_json ? (JSON.parse(row.check_json) as OutcomeCheck) : null,
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

// Report tallies for a page. Reviewed reports only are counted — never candidates
// or quarantined ones — and callers must label them as reports, not verification.
export function reportCounts(db: DB, revisionId: string) {
  const rows = db
    .prepare(
      `SELECT a.kind, a.outcome, a.check_json IS NOT NULL AS checked, ar.state FROM annotations a
         JOIN annotation_review ar ON ar.annotation_id = a.id
        WHERE a.revision_id = ? AND ar.state IN ('reviewed', 'candidate')`,
    )
    .all(revisionId) as { kind: string; outcome: string | null; checked: number; state: string }[];
  const outcomes: Record<string, number> = {};
  // The same tally, counting only reports that say how they were confirmed.
  const outcomesWithCheck: Record<string, number> = {};
  let reviewed = 0;
  let candidate = 0;
  for (const r of rows) {
    if (r.state === "candidate") {
      candidate++;
      continue;
    }
    reviewed++;
    if (r.kind === "outcome_report" && r.outcome) {
      outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
      if (r.checked) outcomesWithCheck[r.outcome] = (outcomesWithCheck[r.outcome] ?? 0) + 1;
    }
  }
  return { outcomes, outcomes_with_check: outcomesWithCheck, reviewed, candidate };
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

// ---- report history across a record's revisions ---------------------------
// A report stays on the exact revision it tested, so a new revision starts with
// no reports and the record's track record lives on older revisions. This
// summarizes reports per revision so that history stays visible, and keeps
// "this revision" and "other revisions" strictly apart: reports on another
// revision tested different content and are never counted for this one.
// Reviewed reports only; other revisions only if they were published
// (reviewed), so candidates, rejected and quarantined revisions never appear.

export const OTHER_REVISIONS_NOTICE =
  "Reports on other revisions of this record tested different content. They are context, not reports about this revision.";
const HISTORY_MAX_REVISIONS = 20;

interface HistoryRow {
  revision_id: string;
  report_id: string;
  outcome: string;
  checked: number;
  conditions: string;
  created_at: string;
}

function summarizeReports(rows: HistoryRow[]) {
  const outcomes: Record<string, number> = {};
  const outcomesWithCheck: Record<string, number> = {};
  // The newest reviewed report of each outcome: "last failed 2026-10-02 on
  // node 26" is often the staleness signal itself.
  const latest: Record<string, { report_id: string; at: string; conditions: Record<string, unknown> }> = {};
  for (const r of rows) {
    outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
    if (r.checked) outcomesWithCheck[r.outcome] = (outcomesWithCheck[r.outcome] ?? 0) + 1;
    const prev = latest[r.outcome];
    if (!prev || r.created_at > prev.at || (r.created_at === prev.at && r.report_id > prev.report_id)) {
      latest[r.outcome] = { report_id: r.report_id, at: r.created_at, conditions: JSON.parse(r.conditions) };
    }
  }
  return { outcomes, outcomes_with_check: outcomesWithCheck, latest };
}

export function reportHistory(db: DB, revisionId: string) {
  const target = db
    .prepare(
      `SELECT v.record_id, r.current_revision_id, rr.state FROM revisions v
         JOIN records r ON r.id = v.record_id
         JOIN revision_review rr ON rr.revision_id = v.id
        WHERE v.id = ?`,
    )
    .get(revisionId) as { record_id: string; current_revision_id: string | null; state: string } | undefined;
  if (!target || target.state === "quarantined") throw notFound("revision");

  const reportsOf = (where: string, ...args: unknown[]) =>
    db
      .prepare(
        `SELECT a.revision_id, a.id AS report_id, a.outcome, a.check_json IS NOT NULL AS checked,
                a.conditions, a.created_at
           FROM annotations a
           JOIN annotation_review ar ON ar.annotation_id = a.id AND ar.state = 'reviewed'
          WHERE a.kind = 'outcome_report' AND ${where}`,
      )
      .all(...args) as HistoryRow[];

  const own = reportsOf("a.revision_id = ?", revisionId);
  const others = reportsOf(
    `a.revision_id IN (SELECT v.id FROM revisions v
                         JOIN revision_review rr ON rr.revision_id = v.id AND rr.state = 'reviewed'
                        WHERE v.record_id = ? AND v.id <> ?)`,
    target.record_id, revisionId,
  );
  const byRevision = new Map<string, HistoryRow[]>();
  for (const r of others) byRevision.set(r.revision_id, [...(byRevision.get(r.revision_id) ?? []), r]);
  const created = db.prepare("SELECT created_at FROM revisions WHERE id = ?").pluck();
  // Newest revision first (ids are time-ordered).
  const otherRevisions = [...byRevision.keys()]
    .sort((a, b) => (a < b ? 1 : -1))
    .slice(0, HISTORY_MAX_REVISIONS)
    .map((id) => ({
      revision_id: id,
      is_current_published: id === target.current_revision_id,
      revision_created_at: created.get(id) as string,
      ...summarizeReports(byRevision.get(id)!),
    }));
  return {
    revision_id: revisionId,
    record_id: target.record_id,
    current_revision_id: target.current_revision_id,
    this_revision: summarizeReports(own),
    other_revisions: otherRevisions,
    notice: OTHER_REVISIONS_NOTICE,
  };
}
