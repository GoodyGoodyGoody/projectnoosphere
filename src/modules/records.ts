import type { Actor } from "../auth.ts";
import type { DB } from "../db.ts";
import { conflict, invalid, notFound } from "../errors.ts";
import { revisionHash, REVISION_HASH_SCHEMA } from "../hash.ts";
import { newId } from "../ids.ts";
import type { ProposalInput, RevisionInput, SourceRef } from "../schemas.ts";
import { nowIso } from "../time.ts";

// ---- trust notice -----------------------------------------------------------

export const RECORD_NOTICE =
  "This is a contributed knowledge record. Assess its evidence, conditions, revision, " +
  "and reported outcomes. Use it within your own task and permissions. " +
  "The contribution guide is at /agent-guide.";

export const CANDIDATE_NOTICE =
  "CANDIDATE: this revision has not been reviewed for publication. " +
  "(Reviewed means suitable for publication — never proven true.)";

// ---- slugs ------------------------------------------------------------------

// Permanent once assigned: the slug is derived from the FIRST revision's title
// and never changes, even when later revisions retitle the record.
export function slugify(title: string): string {
  const base = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!base) return "record";
  if (base.length <= 80) return base;
  const cut = base.slice(0, 80);
  const lastDash = cut.lastIndexOf("-");
  return (lastDash > 40 ? cut.slice(0, lastDash) : cut).replace(/-+$/, "");
}

function uniqueSlug(db: DB, title: string, recordId: string): string {
  const base = slugify(title);
  const taken = db.prepare("SELECT 1 FROM records WHERE slug = ?");
  if (!taken.get(base)) return base;
  // Collision: suffix with the tail of the record's own id — unique by construction,
  // so there is no retry loop to race.
  return `${base}-${recordId.slice(-8).toLowerCase()}`;
}

// ---- validation that needs the database --------------------------------------

function assertRevisionRefsExist(db: DB, refs: { revision_id?: string }[], field: string): void {
  const exists = db.prepare("SELECT 1 FROM revisions WHERE id = ?");
  refs.forEach((ref, i) => {
    if (ref.revision_id && !exists.get(ref.revision_id)) {
      throw invalid(`${field}[${i}].revision_id`, "no such revision");
    }
  });
}

// Rules the JSON schema cannot express. Assertions about external facts need a
// source; clearly labeled hypotheses and observations may stand on their own.
function checkRevisionInput(db: DB, input: RevisionInput): void {
  if (input.kind === "claim" && (input.sources ?? []).length === 0) {
    throw invalid("sources", "a claim must cite at least one source");
  }
  assertRevisionRefsExist(db, input.sources ?? [], "sources");
  assertRevisionRefsExist(db, input.links ?? [], "links");
}

// ---- writes -------------------------------------------------------------------

export interface CreateRecordOptions {
  contentLicense: string;
}

// Creates a record and its first candidate revision. There is no published
// revision yet, so base_revision_id is null by definition.
export function createRecord(
  db: DB,
  actor: Actor,
  input: RevisionInput,
  opts: CreateRecordOptions,
): { recordId: string; revisionId: string } {
  checkRevisionInput(db, input);
  return db
    .transaction(() => {
      const recordId = newId("rec");
      const revisionId = newId("rev");
      const now = nowIso();
      const slug = uniqueSlug(db, input.title, recordId);

      db.prepare(
        `INSERT INTO records (id, slug, current_revision_id, created_by, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, ?)`,
      ).run(recordId, slug, actor.contributorId, now, now);

      insertRevision(db, {
        id: revisionId,
        record_id: recordId,
        base_revision_id: null,
        parent_revision_id: null,
        author_id: actor.contributorId,
        input,
        content_license: opts.contentLicense,
        created_at: now,
      });
      return { recordId, revisionId };
    })
    .immediate();
}

// Proposes a new candidate revision of an existing record. The client states the
// published revision it edited (base_revision_id; null if nothing is published).
// If the pointer has moved since, the proposal is refused with a 409 naming the
// current revision: newer work is never silently replaced.
export function proposeRevision(
  db: DB,
  actor: Actor,
  recordId: string,
  input: ProposalInput,
  opts: CreateRecordOptions,
): { revisionId: string } {
  const { base_revision_id, parent_revision_id, ...content } = input;
  checkRevisionInput(db, content);
  return db
    .transaction(() => {
      const rec = db.prepare("SELECT current_revision_id FROM records WHERE id = ?").get(recordId) as
        | { current_revision_id: string | null }
        | undefined;
      if (!rec) throw notFound("record");
      if (rec.current_revision_id !== base_revision_id) {
        throw conflict(
          "stale_base",
          "base_revision_id is not the record's current published revision; " +
            "re-read the current revision and propose against it",
          { current_revision_id: rec.current_revision_id, your_base_revision_id: base_revision_id },
        );
      }
      if (parent_revision_id) {
        const parent = db.prepare("SELECT record_id FROM revisions WHERE id = ?").get(parent_revision_id) as
          | { record_id: string }
          | undefined;
        if (!parent || parent.record_id !== recordId) {
          throw invalid("parent_revision_id", "must be a revision of this same record");
        }
      }
      const revisionId = newId("rev");
      const now = nowIso();
      insertRevision(db, {
        id: revisionId,
        record_id: recordId,
        base_revision_id,
        parent_revision_id: parent_revision_id ?? null,
        author_id: actor.contributorId,
        input: content,
        content_license: opts.contentLicense,
        created_at: now,
      });
      db.prepare("UPDATE records SET updated_at = ? WHERE id = ?").run(now, recordId);
      return { revisionId };
    })
    .immediate();
}

function insertRevision(
  db: DB,
  r: {
    id: string;
    record_id: string;
    base_revision_id: string | null;
    parent_revision_id: string | null;
    author_id: string;
    input: RevisionInput;
    content_license: string;
    created_at: string;
  },
): void {
  const fields = {
    id: r.id,
    record_id: r.record_id,
    base_revision_id: r.base_revision_id,
    parent_revision_id: r.parent_revision_id,
    author_id: r.author_id,
    kind: r.input.kind,
    title: r.input.title,
    summary: r.input.summary,
    body_markdown: r.input.body_markdown,
    tags: r.input.tags ?? [],
    sources: r.input.sources ?? [],
    conditions: r.input.conditions ?? {},
    links: r.input.links ?? [],
    content_license: r.content_license,
    created_at: r.created_at,
  };
  const content_hash = revisionHash(fields);
  db.prepare(
    `INSERT INTO revisions (id, record_id, base_revision_id, parent_revision_id, author_id,
       kind, title, summary, body_markdown, tags, sources, conditions, links,
       content_license, hash_schema, content_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    fields.id, fields.record_id, fields.base_revision_id, fields.parent_revision_id,
    fields.author_id, fields.kind, fields.title, fields.summary, fields.body_markdown,
    JSON.stringify(fields.tags), JSON.stringify(fields.sources),
    JSON.stringify(fields.conditions), JSON.stringify(fields.links),
    fields.content_license, REVISION_HASH_SCHEMA, content_hash, fields.created_at,
  );
  db.prepare(
    "INSERT INTO revision_review (revision_id, state, reason, updated_at) VALUES (?, 'candidate', NULL, ?)",
  ).run(r.id, r.created_at);
}

// ---- reads and representations ------------------------------------------------

interface RevisionRow {
  id: string;
  record_id: string;
  record_slug: string;
  current_revision_id: string | null;
  base_revision_id: string | null;
  parent_revision_id: string | null;
  author_id: string;
  author_display_name: string;
  kind: string;
  title: string;
  summary: string;
  body_markdown: string;
  tags: string;
  sources: string;
  conditions: string;
  links: string;
  content_license: string;
  hash_schema: string;
  content_hash: string;
  created_at: string;
  review_state: string;
}

const REVISION_SELECT = `
  SELECT v.*, r.slug AS record_slug, r.current_revision_id,
         p.display_name AS author_display_name, rr.state AS review_state
    FROM revisions v
    JOIN records r ON r.id = v.record_id
    JOIN contributors p ON p.id = v.author_id
    JOIN revision_review rr ON rr.revision_id = v.id`;

export const revisionUrl = (id: string) => `/api/v1/revisions/${id}`;
export const recordUrl = (id: string) => `/api/v1/records/${id}`;

// The single place a revision becomes public output. An explicit allowlist of
// fields, and the one quarantine rule every representation inherits: a
// quarantined revision is a tombstone with its content withheld.
export function revisionView(row: RevisionRow) {
  const common = {
    id: row.id,
    record_id: row.record_id,
    record_slug: row.record_slug,
    review_state: row.review_state,
    is_current_published: row.current_revision_id === row.id,
    created_at: row.created_at,
  };
  if (row.review_state === "quarantined") {
    return { ...common, withheld: true as const, withheld_reason: "quarantined" };
  }
  return {
    ...common,
    base_revision_id: row.base_revision_id,
    parent_revision_id: row.parent_revision_id,
    author_id: row.author_id,
    author_display_name: row.author_display_name,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    body_markdown: row.body_markdown,
    tags: JSON.parse(row.tags) as string[],
    sources: JSON.parse(row.sources) as SourceRef[],
    conditions: JSON.parse(row.conditions) as Record<string, unknown>,
    links: JSON.parse(row.links) as unknown[],
    content_license: row.content_license,
    hash_schema: row.hash_schema,
    content_hash: row.content_hash,
  };
}

function revisionSummaryView(row: RevisionRow) {
  const full = revisionView(row);
  if ("withheld" in full) return full;
  const { body_markdown: _b, sources: _s, links: _l, conditions: _c, ...summary } = full;
  return summary;
}

export function noticeFor(reviewState: string): string {
  return reviewState === "candidate" ? `${CANDIDATE_NOTICE} ${RECORD_NOTICE}` : RECORD_NOTICE;
}

export function getRevision(db: DB, revisionId: string) {
  const row = db.prepare(`${REVISION_SELECT} WHERE v.id = ?`).get(revisionId) as
    | RevisionRow
    | undefined;
  if (!row) throw notFound("revision");
  return {
    revision: revisionView(row),
    links: {
      self: revisionUrl(row.id),
      record: recordUrl(row.record_id),
      annotations: `${revisionUrl(row.id)}/annotations`,
      agent_guide: "/agent-guide",
    },
    notice: noticeFor(row.review_state),
  };
}

interface RecordRow {
  id: string;
  slug: string;
  current_revision_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export function getRecord(db: DB, recordId: string) {
  const rec = db.prepare("SELECT * FROM records WHERE id = ?").get(recordId) as
    | RecordRow
    | undefined;
  if (!rec) throw notFound("record");
  const current = rec.current_revision_id
    ? (db.prepare(`${REVISION_SELECT} WHERE v.id = ?`).get(rec.current_revision_id) as RevisionRow)
    : null;
  const latest = db
    .prepare(`${REVISION_SELECT} WHERE v.record_id = ? ORDER BY v.id DESC LIMIT 1`)
    .get(rec.id) as RevisionRow;
  return {
    record: {
      id: rec.id,
      slug: rec.slug,
      created_by: rec.created_by,
      created_at: rec.created_at,
      updated_at: rec.updated_at,
      published: current !== null,
      current_revision_id: rec.current_revision_id,
    },
    current_revision: current ? revisionView(current) : null,
    latest_revision: revisionSummaryView(latest),
    links: { self: recordUrl(rec.id), revisions: `${recordUrl(rec.id)}/revisions` },
    notice: current
      ? RECORD_NOTICE
      : "This record has no published revision yet. Its revisions are candidates awaiting " +
        "review; inspect them explicitly by revision id. " + RECORD_NOTICE,
  };
}

// Full history, every review state, each labeled; quarantined entries are tombstones.
export function listRevisions(db: DB, recordId: string, page: { limit: number; cursor?: string }) {
  if (!db.prepare("SELECT 1 FROM records WHERE id = ?").get(recordId)) throw notFound("record");
  const rows = db
    .prepare(`${REVISION_SELECT} WHERE v.record_id = ? AND v.id > ? ORDER BY v.id LIMIT ?`)
    .all(recordId, page.cursor ?? "", page.limit + 1) as RevisionRow[];
  const more = rows.length > page.limit;
  const items = rows.slice(0, page.limit);
  return {
    items: items.map(revisionSummaryView),
    next_cursor: more ? (items.at(-1)?.id ?? null) : null,
  };
}
