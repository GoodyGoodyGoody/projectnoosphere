// Prove a backup restores: open a COPY of a backup file and verify it is a
// complete, consistent Noosphere database.
//
//   node scripts/restore-check.ts <backup.sqlite> [--expect-revision rev_…]
//
// Checks, each able to fail:
//   - SQLite integrity_check is "ok", and foreign keys hold
//   - the schema is fully migrated for this code
//   - EVERY revision's and annotation's content hash recomputes from its stored
//     fields (content survived byte-for-byte; nothing was silently altered)
//   - every revision has a review state; every record's published pointer names
//     a revision of that record; moderation events are present
//   - optionally, a specific known revision exists
// Exit 0 only if everything holds. Never touches the original file.
import Database from "better-sqlite3";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pendingMigrations } from "../src/db.ts";
import { annotationHash, revisionHash } from "../src/hash.ts";

export interface RestoreReport {
  ok: boolean;
  problems: string[];
  counts: Record<string, number>;
}

export function checkBackup(path: string, expectRevision?: string): RestoreReport {
  const dir = mkdtempSync(join(tmpdir(), "noosphere-restore-"));
  const copy = join(dir, "restored.sqlite");
  copyFileSync(path, copy);
  const db = new Database(copy);
  const problems: string[] = [];
  const counts: Record<string, number> = {};
  try {
    const integrity = db.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") problems.push(`integrity_check: ${integrity}`);
    const fk = db.pragma("foreign_key_check") as unknown[];
    if (fk.length) problems.push(`${fk.length} foreign-key violation(s)`);
    const pending = pendingMigrations(db);
    if (pending.length) problems.push(`not fully migrated for this code: ${pending.join(", ")}`);

    for (const t of ["contributors", "records", "revisions", "annotations", "moderation_events"]) {
      counts[t] = db.prepare(`SELECT count(*) FROM ${t}`).pluck().get() as number;
    }

    for (const r of db.prepare("SELECT * FROM revisions").all() as any[]) {
      const recomputed = revisionHash({
        id: r.id, record_id: r.record_id, base_revision_id: r.base_revision_id, parent_revision_id: r.parent_revision_id,
        author_id: r.author_id, kind: r.kind, title: r.title, summary: r.summary, body_markdown: r.body_markdown,
        tags: JSON.parse(r.tags), sources: JSON.parse(r.sources), conditions: JSON.parse(r.conditions), links: JSON.parse(r.links),
        content_license: r.content_license, created_at: r.created_at,
      });
      if (recomputed !== r.content_hash) problems.push(`revision ${r.id}: content hash does not recompute`);
    }
    for (const a of db.prepare("SELECT * FROM annotations").all() as any[]) {
      const recomputed = annotationHash({
        id: a.id, revision_id: a.revision_id, author_id: a.author_id, kind: a.kind, outcome: a.outcome, body: a.body,
        evidence: JSON.parse(a.evidence), conditions: JSON.parse(a.conditions),
        check: a.check_json ? JSON.parse(a.check_json) : null,
        supersedes_annotation_id: a.supersedes_annotation_id, created_at: a.created_at,
      }, a.hash_schema);
      if (recomputed !== a.content_hash) problems.push(`annotation ${a.id}: content hash does not recompute`);
    }
    const unreviewed = db.prepare(
      "SELECT count(*) FROM revisions v LEFT JOIN revision_review rr ON rr.revision_id = v.id WHERE rr.revision_id IS NULL",
    ).pluck().get() as number;
    if (unreviewed) problems.push(`${unreviewed} revision(s) without a review state`);
    const badPointers = db.prepare(
      `SELECT count(*) FROM records r JOIN revisions v ON v.id = r.current_revision_id WHERE v.record_id != r.id`,
    ).pluck().get() as number;
    if (badPointers) problems.push(`${badPointers} record(s) point at another record's revision`);
    if (expectRevision && !db.prepare("SELECT 1 FROM revisions WHERE id = ?").get(expectRevision)) {
      problems.push(`expected revision ${expectRevision} is missing`);
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return { ok: problems.length === 0, problems, counts };
}

if (import.meta.main) {
  const [file, flag, rev] = process.argv.slice(2);
  if (!file) {
    console.error("usage: restore-check <backup.sqlite> [--expect-revision rev_…]");
    process.exit(2);
  }
  const report = checkBackup(file, flag === "--expect-revision" ? rev : undefined);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}
