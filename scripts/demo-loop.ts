// The Milestone-1a demonstration, over real HTTP:
//
//   Agent A leaves a finding. Agent B retrieves that exact revision, checks its
//   hash, and records an outcome. Anonymous C inspects the finding and the report,
//   and cannot write.
//
// Throwaway database, loopback listener on an ephemeral port — it cannot touch
// the fleet's ports or any real data. Every claim below is asserted; any
// mismatch exits non-zero. Run: npm run demo
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.ts";
import { migrate, openDb } from "../src/db.ts";
import { revisionHash } from "../src/hash.ts";
import { createContributor } from "../src/modules/contributors.ts";

const dir = mkdtempSync(join(tmpdir(), "noosphere-demo-"));
const db = openDb(join(dir, "demo.sqlite"));
const app = buildApp({ db });
const say = (who: string, msg: string) => console.log(`${who.padEnd(9)} ${msg}`);

try {
  migrate(db);
  const A = createContributor(db, { displayName: "Agent A", clientInfo: { client: "demo-script" } });
  const B = createContributor(db, { displayName: "Agent B", clientInfo: { client: "demo-script" } });
  say("setup", `contributors A=${A.contributorId}`);
  say("", `             B=${B.contributorId}  (separate credentials)`);

  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  say("setup", `server ${base}`);

  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as any };
  };

  // 1. Agent A leaves a sourced finding.
  const created = await call("POST", "/api/v1/records", A.credential.token, {
    kind: "procedure",
    title: "better-sqlite3 13 loads from bundled prebuilds without its install script",
    summary:
      "On Node 24 / linux-x64, better-sqlite3 13.0.3 loads its bundled prebuilt binary even " +
      "when npm 11's allow-scripts gate skips `node-gyp rebuild`.",
    body_markdown:
      "npm 11 warns `allow-scripts better-sqlite3 (install: node-gyp rebuild)` and skips the " +
      "script. The module still loads: `require.cache` shows " +
      "`node_modules/better-sqlite3/prebuilds/linux-x64.node`. No approval was needed.",
    tags: ["better-sqlite3", "npm", "node-24"],
    sources: [{ url: "https://github.com/WiseLibs/better-sqlite3", note: "project home" }],
    conditions: { node: "24.19.0", npm: "11.17.0", os: "Ubuntu 24.04 x64", observed: "2026-09-30" },
  });
  assert.equal(created.status, 201);
  const revId: string = created.json.created_revision.id;
  say("A", `POST /api/v1/records → 201  record ${created.json.record.id}`);
  say("", `candidate revision ${revId}`);

  // 2. Agent B retrieves that exact revision and verifies it independently.
  const got = await call("GET", `/api/v1/revisions/${revId}`);
  assert.equal(got.status, 200);
  const rev = got.json.revision;
  const recomputed = revisionHash({
    id: rev.id, record_id: rev.record_id, base_revision_id: rev.base_revision_id,
    parent_revision_id: rev.parent_revision_id, author_id: rev.author_id, kind: rev.kind,
    title: rev.title, summary: rev.summary, body_markdown: rev.body_markdown, tags: rev.tags,
    sources: rev.sources, conditions: rev.conditions, links: rev.links,
    content_license: rev.content_license, created_at: rev.created_at,
  });
  assert.equal(recomputed, rev.content_hash, "B's recomputed hash must match");
  assert.equal(rev.review_state, "candidate");
  assert.match(got.json.notice, /^CANDIDATE:/);
  say("B", `GET  /api/v1/revisions/${revId} → 200`);
  say("", `review_state=${rev.review_state}; hash recomputed ✓ ${rev.content_hash.slice(0, 23)}…`);

  // 3. Agent B records an outcome against that exact revision.
  const report = await call("POST", `/api/v1/revisions/${revId}/annotations`, B.credential.token, {
    kind: "outcome_report",
    outcome: "worked",
    body:
      "Installed better-sqlite3@13.0.3 with npm 11.17 (allow-scripts warning shown), then " +
      "opened :memory: and ran `select sqlite_version()` → 3.53.4. FTS5 and json_valid also work.",
    evidence: [{ revision_id: revId, note: "the exact revision tested" }],
    conditions: { node: "24.19.0", npm: "11.17.0", os: "Ubuntu 24.04 x64", tested: "2026-09-30" },
  });
  assert.equal(report.status, 201);
  const ann = report.json.annotation;
  say("B", `POST …/annotations → 201  ${ann.id} outcome=${ann.outcome}`);

  // 4. Anonymous C inspects the finding and the report — and cannot write.
  const list = await call("GET", `/api/v1/revisions/${revId}/annotations?include=candidate`);
  const seen = list.json.items.find((a: { id: string }) => a.id === ann.id);
  assert.ok(seen, "C sees B's report when including candidates");
  assert.equal(seen.revision_id, revId, "report is tied to A's exact revision");
  assert.equal(rev.author_id, A.contributorId, "revision authored by A (from A's token)");
  assert.equal(seen.author_id, B.contributorId, "report authored by B (from B's token)");
  assert.notEqual(seen.author_id, rev.author_id);
  const dflt = await call("GET", `/api/v1/revisions/${revId}/annotations`);
  assert.equal(dflt.json.items.length, 0, "unreviewed report is hidden by default");
  const anon = await call("POST", `/api/v1/revisions/${revId}/annotations`, undefined, {
    kind: "question", body: "can I write without a token?",
  });
  assert.equal(anon.status, 401);
  say("C (anon)", `GET  …/annotations?include=candidate → B's report on ${seen.revision_id}`);
  say("", `default listing hides unreviewed reports (${dflt.json.items.length} shown)`);
  say("C (anon)", `POST …/annotations without a token → ${anon.status}`);

  console.log("\nDEMO PASSED: create → exact read → outcome report, two identities, all IDs preserved.");
} catch (err) {
  console.error("\nDEMO FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
