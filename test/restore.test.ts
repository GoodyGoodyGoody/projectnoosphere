import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { checkBackup } from "../scripts/restore-check.ts";
import { bearer, propose, publish, publishedRecord, sampleOutcome, setup } from "./helpers.ts";

describe("backup restore check", () => {
  let t: ReturnType<typeof setup>;
  let backupPath: string;
  let known: string;
  before(async () => {
    t = setup();
    const r = await publishedRecord(t, t.a.token, { title: "Restorable record" });
    known = r.revisionId;
    await t.app.inject({ method: "POST", url: `/api/v1/revisions/${r.revisionId}/annotations`, headers: bearer(t.b.token), payload: sampleOutcome() });
    const r2 = (await propose(t.app, t.b.token, r.recordId, r.revisionId, { title: "Restorable, corrected" })).json().revision.id;
    await publish(t.app, t.s.token, r2);
    // The same online-backup API data-backup.sh uses (sqlite3 .backup).
    backupPath = join(t.dir, "backup.sqlite");
    await t.db.backup(backupPath);
  });
  after(() => t.close());

  test("a real backup restores completely", () => {
    const report = checkBackup(backupPath, known);
    assert.deepEqual(report.problems, []);
    assert.equal(report.ok, true);
    assert.equal(report.counts.revisions, 2);
    assert.equal(report.counts.annotations, 1);
    assert.ok(report.counts.moderation_events! >= 2);
  });

  test("the check fails on altered content and on a missing known revision", () => {
    // Corrupt a copy the way tampering or a bad restore would: change stored
    // content behind the immutability trigger.
    const tampered = join(t.dir, "tampered.sqlite");
    copyFileSync(backupPath, tampered);
    const db = new Database(tampered);
    db.exec("DROP TRIGGER revisions_no_update");
    db.prepare("UPDATE revisions SET title = 'altered' WHERE id = ?").run(known);
    db.close();
    const bad = checkBackup(tampered);
    assert.equal(bad.ok, false);
    assert.ok(bad.problems.some((p) => p.includes(known) && /does not recompute/.test(p)), JSON.stringify(bad.problems));
    const missing = checkBackup(backupPath, "rev_01M3RZZZZZZZZZZZZZZZZZZZZZ");
    assert.equal(missing.ok, false);
    assert.match(missing.problems.join(" "), /expected revision .* is missing/);
  });
});
