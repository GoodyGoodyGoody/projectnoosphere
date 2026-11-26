// Offline rehearsal of migration 009 and the pre-task API. No live data, env
// files, listeners or model calls. Pass an assigned scratch directory.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { migrate, openDb } from "../src/db.ts";
import { createContributor } from "../src/modules/contributors.ts";

const BASELINE = "e79854eab7737da6126ec15aa29ba4b9681701ba";
const scratch = process.argv[2];
if (!scratch || !isAbsolute(scratch)) throw new Error("pass an absolute scratch directory");
const root = join(import.meta.dirname, "..");
const dir = mkdtempSync(join(scratch, "verify-rollback-"));
const legacy = join(dir, "previous");
const files = execFileSync("git", ["ls-tree", "-r", "--name-only", BASELINE, "src", "mcp", "docs", "migrations", "package.json"], { cwd: root, encoding: "utf8" }).trim().split("\n");
let db: ReturnType<typeof openDb> | undefined;
let app: any;
try {
  for (const file of files) {
    const dest = join(legacy, file);
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    writeFileSync(dest, execFileSync("git", ["show", `${BASELINE}:${file}`], { cwd: root }));
  }
  symlinkSync(join(root, "node_modules"), join(legacy, "node_modules"), "dir");
  const oldDb = await import(pathToFileURL(join(legacy, "src/db.ts")).href);
  const oldApp = await import(pathToFileURL(join(legacy, "src/app.ts")).href);
  db = openDb(join(dir, "rehearsal.sqlite"));
  assert.equal(oldDb.migrate(db).length, 8);
  const a = createContributor(db, { displayName: "Rollback test agent" });
  app = oldApp.buildApp({ db });
  const headers = { authorization: `Bearer ${a.credential.token}` };
  const create = async (title: string) => {
    const made = await app.inject({ method: "POST", url: "/api/v1/records", headers, payload: {
      kind: "procedure", title, summary: "Round trip on a temporary SQLite database.", body_markdown: "Read the exact revision and attach a report.",
    } });
    assert.equal(made.statusCode, 201, made.body);
    assert.equal(made.json().created_revision.hash_schema, "noosphere-revision/1");
    return made.json().created_revision;
  };
  const report = async (revisionId: string) => {
    const posted = await app.inject({ method: "POST", url: `/api/v1/revisions/${revisionId}/annotations`, headers, payload: {
      kind: "outcome_report", outcome: "worked", body: "Read the exact revision, attached this report and confirmed its revision id.",
      conditions: { node: process.versions.node, os: process.platform }, check: { ran: "read the annotations response", observed: "report revision_id matches the exact revision read" },
    } });
    assert.equal(posted.statusCode, 201, posted.body);
    assert.equal(posted.json().annotation.hash_schema, "noosphere-annotation/2");
    return posted.json().annotation;
  };
  const before = await create("Revision created before migration 009");
  const ann = await report(before.id);
  assert.deepEqual(migrate(db), ["009_revision_verify"]);
  assert.deepEqual(migrate(db), [], "migration is idempotent");
  const read = (await app.inject({ url: `/api/v1/revisions/${before.id}` })).json().revision;
  assert.equal(read.content_hash, before.content_hash);
  const oldReports = (await app.inject({ url: `/api/v1/revisions/${before.id}/annotations?include=candidate` })).json().items;
  assert.equal(oldReports[0].content_hash, ann.content_hash);
  const after = await create("Previous API creates after migration 009");
  const newReport = await report(after.id);
  const afterRead = (await app.inject({ url: `/api/v1/revisions/${after.id}` })).json().revision;
  assert.deepEqual(afterRead, after);
  const reports = (await app.inject({ url: `/api/v1/revisions/${after.id}/annotations?include=candidate` })).json().items;
  assert.equal(reports[0].id, newReport.id);
  assert.equal(reports[0].revision_id, after.id);
  console.log(`PASS: baseline ${BASELINE.slice(0, 12)} API creates revision /1, reports with annotation /2 and reads after migration 009; pre-migration hashes unchanged; migration reapplies as a no-op. SQLite ${db.prepare("select sqlite_version()").pluck().get()}.`);
} finally {
  if (app) await app.close();
  db?.close();
  rmSync(dir, { recursive: true, force: true });
}
