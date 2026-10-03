import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { annotationHash } from "../src/hash.ts";
import { isBareSuccess } from "../src/modules/annotations.ts";
import { newId } from "../src/ids.ts";
import { bearer, publishedRecord, sampleOutcome, setup } from "./helpers.ts";

// An outcome report says how it was confirmed: what the reporter ran or
// inspected, and what it showed. Asked for on r/mcp: "agents say
// 'worked' when the command exited 0". Migration 006, hash schema /2.
describe("outcome reports carry their check", () => {
  let t: ReturnType<typeof setup>;
  let revisionId: string;
  before(async () => {
    t = setup();
    ({ revisionId } = await publishedRecord(t, t.a.token, { title: "Record that takes checked reports" }));
  });
  after(() => t.close());

  const post = (payload: unknown) =>
    t.app.inject({ method: "POST", url: `/api/v1/revisions/${revisionId}/annotations`, headers: bearer(t.b.token), payload: payload as object });
  const count = () => (t.db.prepare("SELECT count(*) FROM annotations").pluck().get() as number);

  test("worked, failed and partially worked need a check; the error names it", async () => {
    for (const outcome of ["worked", "failed", "partially_worked"] as const) {
      const before = count();
      const res = await post(sampleOutcome({ outcome, check: undefined }));
      assert.equal(res.statusCode, 400, outcome);
      assert.equal(res.json().error.fields[0].path, "check", outcome);
      assert.match(res.json().error.fields[0].message, /check\.ran.*check\.observed/);
      assert.equal(count(), before, `${outcome}: a report without a check was stored`);
    }
  });

  test("not applicable and inconclusive may come without one", async () => {
    for (const outcome of ["not_applicable", "inconclusive"] as const) {
      const res = await post(sampleOutcome({ outcome, check: undefined }));
      assert.equal(res.statusCode, 201, outcome);
      assert.equal(res.json().annotation.check, null);
    }
  });

  test("a bare exit code or 'ok' is not a check", async () => {
    for (const observed of ["exit code 0", "Exited with status 0.", "0", "OK", "success!", "it worked", "no errors"]) {
      const res = await post(sampleOutcome({ check: { ran: "npm test", observed } }));
      assert.equal(res.statusCode, 400, observed);
      assert.equal(res.json().error.fields[0].path, "check.observed", observed);
    }
    const real = await post(sampleOutcome({ check: { ran: "npm test", observed: "exit code 0; 143 tests, 0 failures" } }));
    assert.equal(real.statusCode, 201, "an exit code WITH what the check showed is a check");
  });

  test("the detector separates claims of success from observations", () => {
    for (const s of ["exit 0", "rc=0", "Exit status: 0", "returned 0", "Done!", "\"ok\"", "passed"]) assert.ok(isBareSuccess(s), s);
    for (const s of ["HTTP/2 200", "3.53.4", "200 OK", "0 failures, 12 passed", "ok: 3 rows"]) assert.ok(!isBareSuccess(s), s);
  });

  test("only an outcome report carries a check", async () => {
    const res = await post({ kind: "critique", body: "A critique is not a test report.", check: { ran: "x", observed: "y" } });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.fields[0].path, "check");
  });

  test("a check is scanned for secrets like the rest of the report", async () => {
    const res = await post(sampleOutcome({ check: { ran: "curl -H 'Authorization: Bearer sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' https://example.com", observed: "HTTP/2 200" } }));
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.fields[0].path, "check.ran");
  });

  test("the check is part of the content hash (schema /2); /1 rows still verify", async () => {
    const ann = (await post(sampleOutcome())).json().annotation;
    const input = {
      id: ann.id, revision_id: ann.revision_id, author_id: ann.author_id, kind: ann.kind, outcome: ann.outcome,
      body: ann.body, evidence: ann.evidence, conditions: ann.conditions, check: ann.check,
      supersedes_annotation_id: ann.supersedes_annotation_id, created_at: ann.created_at,
    };
    assert.equal(annotationHash(input, "noosphere-annotation/2"), ann.content_hash);
    assert.notEqual(
      annotationHash({ ...input, check: { ...ann.check, observed: "something else" } }, "noosphere-annotation/2"),
      ann.content_hash,
      "changing the check does not change the hash",
    );
    // A report written before checks existed must hash exactly as v0.1.9 did.
    // Golden value computed with v0.1.9's src/hash.ts on 2026-10-03.
    const before = {
      id: "ann_01K6M0000000000000000000AA", revision_id: "rev_01K6M0000000000000000000AA", author_id: "ctr_01K6M0000000000000000000AA",
      kind: "outcome_report", outcome: "worked", body: "Followed it before checks were asked for; it worked as written.",
      evidence: [], conditions: { os: "Ubuntu 24.04" }, supersedes_annotation_id: null, created_at: "2026-10-01T00:00:00.000Z",
    };
    const golden = "sha256:1079426018a8c4f7ffbed49624930cad93e02c282ef9843d6af5a280f28cdf0b";
    assert.equal(annotationHash(before, "noosphere-annotation/1"), golden);
    assert.equal(annotationHash({ ...before, check: null }, "noosphere-annotation/1"), golden);
    assert.throws(() => annotationHash(input, "noosphere-annotation/9"), /unknown annotation hash schema/);
  });

  test("the database enforces it for new rows, and leaves the previous release's rows alone", () => {
    const insert = (schema: string, kind: string, outcome: string | null, check: string | null) =>
      t.db.prepare(
        `INSERT INTO annotations (id, revision_id, author_id, kind, outcome, body, evidence, conditions, check_json,
           supersedes_annotation_id, hash_schema, content_hash, created_at)
         VALUES (?, ?, ?, ?, ?, 'direct insert', '[]', '{}', ?, NULL, ?, 'sha256:x', '2026-10-03T00:00:00Z')`,
      ).run(newId("ann"), revisionId, t.b.id, kind, outcome, check, schema);
    assert.throws(() => insert("noosphere-annotation/2", "outcome_report", "worked", null), /needs its check/);
    assert.throws(() => insert("noosphere-annotation/2", "critique", null, '{"ran":"x","observed":"y"}'), /only an outcome report/);
    assert.throws(() => insert("noosphere-annotation/2", "outcome_report", "worked", "not json"), /CHECK constraint/);
    // Rollback safety: the previous release writes /1 rows without a check.
    assert.doesNotThrow(() => insert("noosphere-annotation/1", "outcome_report", "worked", null));
    assert.doesNotThrow(() => insert("noosphere-annotation/2", "outcome_report", "inconclusive", null));
  });

  test("the page counts checked reports separately and shows each check", async () => {
    const t2 = setup();
    try {
      const r = await publishedRecord(t2, t2.a.token, { title: "Record with mixed reports" });
      const report = async (payload: object) =>
        (await t2.app.inject({ method: "POST", url: `/api/v1/revisions/${r.revisionId}/annotations`, headers: bearer(t2.b.token), payload })).json().annotation.id as string;
      const approve = (id: string) => t2.app.inject({
        method: "POST", url: "/api/v1/admin/moderation-events", headers: bearer(t2.s.token),
        payload: { action: "approve_annotation", target_id: id, reason: "ok" },
      });
      await approve(await report(sampleOutcome({ check: { ran: "curl -sI https://example.com/health", observed: "HTTP/2 200" } })));
      // A report from before checks existed: written straight in as a /1 row, then approved.
      const old = newId("ann");
      t2.db.prepare(
        `INSERT INTO annotations (id, revision_id, author_id, kind, outcome, body, evidence, conditions, check_json,
           supersedes_annotation_id, hash_schema, content_hash, created_at)
         VALUES (?, ?, ?, 'outcome_report', 'worked', 'Followed it before checks were asked for; it worked.', '[]', '{"os":"x"}', NULL,
           NULL, 'noosphere-annotation/1', 'sha256:x', '2026-10-01T00:00:00Z')`,
      ).run(old, r.revisionId, t2.b.id);
      t2.db.prepare("INSERT INTO annotation_review (annotation_id, state, reason, updated_at) VALUES (?, 'candidate', NULL, ?)").run(old, "2026-10-01T00:00:00Z");
      await approve(old);
      const body = (await t2.app.inject({ method: "GET", url: `/r/${r.slug}` })).body;
      assert.match(body, /worked 2 \(1 with a check\)/);
      assert.match(body, /<strong>Check:<\/strong> <code>curl -sI https:\/\/example.com\/health<\/code>/);
      assert.match(body, /It showed:<\/strong> HTTP\/2 200/);
      assert.match(body, /No check attached\./);
    } finally {
      await t2.close();
    }
  });
});
