// The Phase-1 demonstration, over real HTTP:
//
//   Agent A leaves a finding. Agent B retrieves that exact revision, checks its
//   hash, and records an outcome. A steward (the librarian's role, ADR 0005)
//   publishes. B proposes a correction — retrying it safely with an
//   Idempotency-Key — and it is published. A, editing from a stale copy, is
//   refused with a 409 that names the current revision. Anonymous C then sees:
//   the corrected record, the original revision intact, and B's report still
//   attached to the exact revision it tested.
//
// Throwaway database, loopback listener on an ephemeral port — it cannot touch
// the fleet's ports or any real data. Every claim is asserted; any mismatch
// exits non-zero. Run: npm run demo
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
const short = (id: string) => `${id.slice(0, 4)}…${id.slice(-6)}`;

function recompute(rev: any): string {
  return revisionHash({
    id: rev.id, record_id: rev.record_id, base_revision_id: rev.base_revision_id,
    parent_revision_id: rev.parent_revision_id, author_id: rev.author_id, kind: rev.kind,
    title: rev.title, summary: rev.summary, body_markdown: rev.body_markdown, tags: rev.tags,
    sources: rev.sources, conditions: rev.conditions, links: rev.links,
    content_license: rev.content_license, created_at: rev.created_at,
  });
}

const FINDING = {
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
};

try {
  migrate(db);
  const A = createContributor(db, { displayName: "Agent A" });
  const B = createContributor(db, { displayName: "Agent B" });
  const S = createContributor(db, { displayName: "Librarian (steward)", role: "steward" });
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  say("setup", `A, B, steward — separate credentials; server ${base}`);

  const call = async (method: string, path: string, token?: string, body?: unknown, key?: string) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
        ...(key ? { "idempotency-key": key } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as any, replayed: res.headers.get("idempotent-replayed") };
  };
  const moderate = (action: string, target_id: string, reason: string) =>
    call("POST", "/api/v1/admin/moderation-events", S.credential.token, { action, target_id, reason });

  // 1. A leaves a sourced finding.
  const created = await call("POST", "/api/v1/records", A.credential.token, FINDING);
  assert.equal(created.status, 201);
  const recId: string = created.json.record.id;
  const rev1: string = created.json.created_revision.id;
  say("A", `creates record ${short(recId)} → candidate rev1 ${short(rev1)}`);

  // 2. B reads that exact revision, verifies it, and reports what happened.
  const got = await call("GET", `/api/v1/revisions/${rev1}`);
  assert.equal(recompute(got.json.revision), got.json.revision.content_hash);
  assert.equal(got.json.revision.review_state, "candidate");
  const report = await call("POST", `/api/v1/revisions/${rev1}/annotations`, B.credential.token, {
    kind: "outcome_report",
    outcome: "worked",
    body:
      "Installed better-sqlite3@13.0.3 with npm 11.17 (allow-scripts warning shown), opened " +
      ":memory:, `select sqlite_version()` → 3.53.4. Note: prebuilds/ ships 8 platform " +
      "binaries, so the claim is likely broader than linux-x64 — but I only tested x64.",
    evidence: [{ revision_id: rev1, note: "the exact revision tested" }],
    conditions: { node: "24.19.0", npm: "11.17.0", os: "Ubuntu 24.04 x64", tested: "2026-09-30" },
  });
  assert.equal(report.status, 201);
  const annId: string = report.json.annotation.id;
  say("B", `reads rev1, hash ✓, reports outcome=worked on rev1`);

  // 3. The steward publishes rev1 and approves B's report.
  assert.equal((await moderate("publish_revision", rev1, "sourced, specific, fit to publish")).status, 201);
  assert.equal((await moderate("approve_annotation", annId, "a concrete observation")).status, 201);
  say("steward", "publishes rev1; approves B's report");

  // 4. B proposes a correction, and retries it (lost response) with the same key.
  const correction = {
    ...FINDING,
    summary:
      "better-sqlite3 13.0.3 bundles prebuilds for 8 platforms (darwin, linux glibc/musl, " +
      "win32; x64 and arm64) and loads them when npm 11 skips the install script. Observed on linux-x64.",
    conditions: { ...FINDING.conditions, limitations: "Only linux-x64 was observed; other platforms inferred from prebuilds/." },
    base_revision_id: rev1,
  };
  const p1 = await call("POST", `/api/v1/records/${recId}/revisions`, B.credential.token, correction, "b-correction-1");
  const p2 = await call("POST", `/api/v1/records/${recId}/revisions`, B.credential.token, correction, "b-correction-1");
  assert.equal(p1.status, 201);
  assert.equal(p2.status, 201);
  assert.equal(p2.replayed, "true");
  const rev2: string = p1.json.revision.id;
  assert.equal(p2.json.revision.id, rev2, "the retry returns the same revision");
  say("B", `proposes correction rev2 ${short(rev2)} (base rev1)`);
  say("", "retry with same Idempotency-Key → replayed, no duplicate");

  // 5. Published: the pointer moves from rev1 to rev2 by compare-and-set.
  const pub = await moderate("publish_revision", rev2, "narrows an over-general claim");
  assert.equal(pub.status, 201);
  assert.equal(pub.json.event.previous_revision_id, rev1);
  say("steward", "publishes rev2 (pointer rev1 → rev2)");

  // 6. A edits from its stale copy of rev1 and is refused.
  const stale = await call("POST", `/api/v1/records/${recId}/revisions`, A.credential.token, {
    ...FINDING, title: "A's edit from an old copy", base_revision_id: rev1,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error.code, "stale_base");
  assert.equal(stale.json.error.details.current_revision_id, rev2);
  say("A", "edits from stale rev1 → 409 stale_base, current is rev2");

  // 7. Anonymous C inspects everything.
  const rec = await call("GET", `/api/v1/records/${recId}`);
  assert.equal(rec.json.current_revision.id, rev2);
  const old = await call("GET", `/api/v1/revisions/${rev1}`);
  assert.equal(old.json.revision.is_current_published, false);
  assert.equal(recompute(old.json.revision), old.json.revision.content_hash, "rev1 unchanged");
  const onOld = await call("GET", `/api/v1/revisions/${rev1}/annotations`);
  assert.deepEqual(onOld.json.items.map((a: any) => a.id), [annId]);
  assert.equal(onOld.json.items[0].revision_id, rev1);
  assert.equal(onOld.json.items[0].author_id, B.contributorId);
  const onNew = await call("GET", `/api/v1/revisions/${rev2}/annotations?include=candidate`);
  assert.equal(onNew.json.items.length, 0, "B's report did not migrate to rev2");
  const hist = await call("GET", `/api/v1/records/${recId}/revisions`);
  assert.deepEqual(hist.json.items.map((r: any) => r.id), [rev1, rev2]);
  const anon = await call("POST", `/api/v1/revisions/${rev2}/annotations`, undefined, { kind: "question", body: "?" });
  assert.equal(anon.status, 401);
  say("C (anon)", "record shows rev2; rev1 intact (hash ✓), not current");
  say("", "B's report still on rev1, none on rev2; history [rev1, rev2]");
  say("C (anon)", `writes without a token → ${anon.status}`);

  console.log("\nDEMO PASSED: find → verify → report → publish → correct → conflict, every ID preserved.");
} catch (err) {
  console.error("\nDEMO FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
