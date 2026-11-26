import assert from "node:assert/strict";
import { test } from "node:test";
import { revisionHash, annotationHash, canonicalJson, sha256 } from "../src/hash.ts";
import { newId } from "../src/ids.ts";
import { bearer, createRecordAs, publishedRecord, sampleRecord, sampleOutcome, setup } from "./helpers.ts";

const verify = { run: "node health-check.ts", expect: "prints status=ready and rows=3" };

test("revision /1 hash remains byte identical; /2 freezes both check fields", async () => {
  const t = setup();
  try {
    const { json } = await createRecordAs(t.app, t.a.token);
    const r = json.created_revision;
    const input = {
      id: r.id, record_id: r.record_id, base_revision_id: r.base_revision_id,
      parent_revision_id: r.parent_revision_id, author_id: r.author_id, kind: r.kind,
      title: r.title, summary: r.summary, body_markdown: r.body_markdown,
      tags: r.tags, sources: r.sources, conditions: r.conditions, links: r.links,
      content_license: r.content_license, created_at: r.created_at,
    };
    // The complete pre-change hash algorithm, independent of revisionHash.
    assert.equal(r.hash_schema, "noosphere-revision/1");
    assert.equal(revisionHash(input), sha256(canonicalJson({ schema: "noosphere-revision/1", ...input })));
    assert.equal(revisionHash({ ...input, verify: null }), r.content_hash);
    for (const expect of ["exit code 0", "OK", "Exited with status 0.", "   "]) {
      const res = await t.app.inject({ method: "POST", url: "/api/v1/records", headers: bearer(t.a.token), payload: sampleRecord({ verify: { ...verify, expect } }) });
      assert.equal(res.statusCode, 400, expect);
    }
    for (const bad of [{ run: "x" }, { ...verify, extra: true }, { ...verify, run: "x".repeat(2001) }, { ...verify, expect: "x".repeat(4001) }]) {
      const res = await t.app.inject({ method: "POST", url: "/api/v1/records", headers: bearer(t.a.token), payload: { ...sampleRecord(), verify: bad } });
      assert.equal(res.statusCode, 400);
    }
    const made = (await createRecordAs(t.app, t.a.token, sampleRecord({ verify }))).json.created_revision;
    const fields = { ...input, id: made.id, record_id: made.record_id, created_at: made.created_at, verify };
    assert.equal(made.hash_schema, "noosphere-revision/2");
    assert.equal(revisionHash(fields), made.content_hash);
    assert.notEqual(revisionHash({ ...fields, verify: { ...verify, run: "different" } }), made.content_hash);
    assert.notEqual(revisionHash({ ...fields, verify: { ...verify, expect: "different" } }), made.content_hash);
    assert.throws(() => t.db.prepare("UPDATE revisions SET verify_json = NULL WHERE id = ?").run(made.id), /immutable/);
  } finally { await t.close(); }
});

test("stated requires verify, hashes true and false, and counts only reviewed true reports", async () => {
  const t = setup();
  try {
    const no = await publishedRecord(t, t.a.token);
    const r = await publishedRecord(t, t.a.token, { title: "A revision with a frozen check", verify, conditions: { node: "24" } });
    const post = (id: string, stated?: boolean) => t.app.inject({
      method: "POST", url: `/api/v1/revisions/${id}/annotations`, headers: bearer(t.b.token),
      payload: sampleOutcome({ conditions: { node: "24" }, check: { ran: verify.run, observed: verify.expect, ...(stated !== undefined ? { stated } : {}) } }),
    });
    for (const stated of [true, false]) assert.equal((await post(no.revisionId, stated)).statusCode, 400);
    for (const stated of [true, false, undefined, true]) {
      const res = await post(r.revisionId, stated);
      assert.equal(res.statusCode, 201, res.body);
      const a = res.json().annotation;
      assert.equal(a.hash_schema, stated === undefined ? "noosphere-annotation/2" : "noosphere-annotation/3");
      const fields = { id: a.id, revision_id: a.revision_id, author_id: a.author_id, kind: a.kind, outcome: a.outcome, body: a.body, evidence: a.evidence, conditions: a.conditions, check: a.check, supersedes_annotation_id: a.supersedes_annotation_id, created_at: a.created_at };
      assert.equal(annotationHash(fields), a.content_hash);
      if (stated !== undefined) assert.notEqual(annotationHash({ ...fields, check: { ...a.check, stated: !stated } }), a.content_hash);
      // Leave the last true report a candidate.
      const n = t.db.prepare("SELECT count(*) FROM annotations WHERE revision_id = ?").pluck().get(r.revisionId);
      if (n !== 4) {
        const approved = await t.app.inject({ method: "POST", url: "/api/v1/admin/moderation-events", headers: bearer(t.s.token), payload: { action: "approve_annotation", target_id: a.id, reason: "concrete test report" } });
        assert.equal(approved.statusCode, 201);
      }
    }
    const history = (await t.app.inject({ url: `/api/v1/revisions/${r.revisionId}/report-history` })).json();
    assert.deepEqual(history.this_revision.outcomes, { worked: 3 });
    assert.deepEqual(history.this_revision.outcomes_with_check, { worked: 3 });
    assert.deepEqual(history.this_revision.outcomes_with_stated_check, { worked: 1 });
    assert.equal(history.this_revision.by_conditions.cells[0].with_stated_check, 1);
    assert.deepEqual(history.this_revision.by_conditions.cells[0].outcomes_with_stated_check, { worked: 1 });
    const page = (await t.app.inject({ url: `/r/${r.slug}` })).body;
    assert.match(page, /Stated check/);
    assert.match(page, /node health-check.ts/);
    assert.match(page, /worked: 1 ran the stated check/);
    assert.match(page, /Did not run the stated check exactly/);
    for (const path of ["", "/markdown"]) {
      const res = await t.app.inject({ url: `/api/v1/revisions/${r.revisionId}${path}` });
      assert.ok(res.body.includes(verify.run));
      assert.ok(res.body.includes(verify.expect));
    }
    t.db.prepare("UPDATE revision_review SET state = 'quarantined' WHERE revision_id = ?").run(r.revisionId);
    for (const path of ["", "/markdown"]) assert.ok(!(await t.app.inject({ url: `/api/v1/revisions/${r.revisionId}${path}` })).body.includes(verify.run));
  } finally { await t.close(); }
});

test("migration guards new hash schemas and allows legacy writers", async () => {
  const t = setup();
  try {
    const r = await publishedRecord(t, t.a.token, { verify });
    const old = await publishedRecord(t, t.a.token, { title: "Legacy revision without verify" });
    const insertRev = (schema: string, check: string | null) => t.db.prepare(`INSERT INTO revisions
      (id, record_id, author_id, kind, title, summary, body_markdown, tags, sources, conditions, links, content_license, hash_schema, content_hash, created_at, verify_json)
      VALUES (?, ?, ?, 'procedure', 'direct insert', 's', 'b', '[]', '[]', '{}', '[]', 'CC0-1.0', ?, 'sha256:x', '2026-11-26', ?)`).run(newId("rev"), r.recordId, t.a.id, schema, check);
    for (const bad of [null, '{}', '[]', '{"run":"x","expect":"ok"}', JSON.stringify({ ...verify, run: "x".repeat(2001) }), JSON.stringify({ ...verify, expect: 42 })]) {
      assert.throws(() => insertRev("noosphere-revision/2", bad), /verify/);
    }
    assert.doesNotThrow(() => insertRev("noosphere-revision/2", JSON.stringify(verify)));
    assert.doesNotThrow(() => insertRev("noosphere-revision/1", null));
    const insertAnn = (schema: string, target: string, check: string | null) => t.db.prepare(`INSERT INTO annotations
      (id, revision_id, author_id, kind, outcome, body, evidence, conditions, hash_schema, content_hash, created_at, check_json)
      VALUES (?, ?, ?, 'outcome_report', 'worked', 'direct insert', '[]', '{}', ?, 'sha256:x', '2026-11-26', ?)`).run(newId("ann"), target, t.b.id, schema, check);
    for (const bad of [null, '{}', '[]', JSON.stringify({ ran: "x", observed: "3 rows" }), JSON.stringify({ ran: "x", observed: "3 rows", stated: "true" }), JSON.stringify({ ran: "x".repeat(2001), observed: "3 rows", stated: true })]) {
      assert.throws(() => insertAnn("noosphere-annotation/3", r.revisionId, bad), /check/);
    }
    const check = JSON.stringify({ ran: verify.run, observed: verify.expect, stated: true });
    assert.throws(() => insertAnn("noosphere-annotation/3", old.revisionId, check), /requires revision verify/);
    assert.doesNotThrow(() => insertAnn("noosphere-annotation/3", r.revisionId, check));
    assert.doesNotThrow(() => insertAnn("noosphere-annotation/1", old.revisionId, null));
    assert.doesNotThrow(() => insertAnn("noosphere-annotation/2", old.revisionId, JSON.stringify({ ran: "x", observed: "3 rows" })));
  } finally { await t.close(); }
});
