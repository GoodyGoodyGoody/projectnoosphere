import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { canonicalJson, revisionHash } from "../src/hash.ts";
import { authenticate } from "../src/auth.ts";
import { createRecord, getRevision, slugify } from "../src/modules/records.ts";
import { bearer, count, createRecordAs, publish, sampleRecord, setup } from "./helpers.ts";

// Recompute a revision's hash from nothing but its public JSON — what an
// independent client would do.
function recomputeFromView(v: Record<string, any>): string {
  return revisionHash({
    id: v.id, record_id: v.record_id, base_revision_id: v.base_revision_id,
    parent_revision_id: v.parent_revision_id, author_id: v.author_id, kind: v.kind,
    title: v.title, summary: v.summary, body_markdown: v.body_markdown, tags: v.tags,
    sources: v.sources, conditions: v.conditions, links: v.links,
    content_license: v.content_license, created_at: v.created_at,
  });
}

describe("records and exact revisions", () => {
  let t: ReturnType<typeof setup>;
  before(() => { t = setup(); });
  after(() => t.close());

  test("create: record + candidate revision, authored by the token's contributor", async () => {
    const res = await t.app.inject({
      method: "POST", url: "/api/v1/records", headers: bearer(t.a.token), payload: sampleRecord(),
    });
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.equal(res.headers.location, `/api/v1/records/${body.record.id}`);
    assert.equal(body.record.published, false);
    assert.equal(body.record.current_revision_id, null);
    assert.equal(body.current_revision, null);
    assert.match(body.notice, /no published revision yet/);
    const rev = body.created_revision;
    assert.equal(rev.author_id, t.a.id);
    assert.equal(rev.review_state, "candidate");
    assert.equal(rev.is_current_published, false);
    assert.equal(rev.base_revision_id, null);
    assert.equal(rev.content_license, "CC0-1.0");
    assert.equal(body.latest_revision.id, rev.id);
  });

  test("a spoofed author_id is rejected by name, and nothing is written", async () => {
    const before = [count(t.db, "records"), count(t.db, "revisions")];
    const res = await t.app.inject({
      method: "POST", url: "/api/v1/records", headers: bearer(t.a.token),
      payload: { ...sampleRecord(), author_id: t.b.id },
    });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json().error.fields, [
      { path: "author_id", message: "is not an accepted field", location: "body" },
    ]);
    assert.deepEqual([count(t.db, "records"), count(t.db, "revisions")], before);
  });

  test("second layer: the module takes authorship from the Actor even if the schema were bypassed", () => {
    const actor = authenticate(t.db, `Bearer ${t.a.token}`);
    const spoofed = { ...sampleRecord(), author_id: t.b.id } as ReturnType<typeof sampleRecord>;
    const { revisionId } = createRecord(t.db, actor, spoofed, { contentLicense: "test" });
    const rev = getRevision(t.db, revisionId).revision as { author_id: string };
    assert.equal(rev.author_id, t.a.id);
  });

  test("exact read returns the same revision, and the hash recomputes from public JSON", async () => {
    const { revisionId, json } = await createRecordAs(t.app, t.a.token);
    const res = await t.app.inject({ method: "GET", url: `/api/v1/revisions/${revisionId}` });
    assert.equal(res.statusCode, 200);
    const read = res.json();
    assert.deepEqual(read.revision, json.created_revision);
    assert.match(read.notice, /^CANDIDATE:/);
    assert.equal(read.links.annotations, `/api/v1/revisions/${revisionId}/annotations`);
    assert.equal(recomputeFromView(read.revision), read.revision.content_hash);
    // Any content change changes the hash.
    assert.notEqual(recomputeFromView({ ...read.revision, title: read.revision.title + "!" }), read.revision.content_hash);
    assert.notEqual(recomputeFromView({ ...read.revision, conditions: {} }), read.revision.content_hash);
  });

  test("canonical JSON ignores key order and rejects non-finite numbers", () => {
    assert.equal(canonicalJson({ b: [1, { d: 1, c: 2 }], a: "x" }), canonicalJson({ a: "x", b: [1, { c: 2, d: 1 }] }));
    assert.equal(canonicalJson({ b: 1, a: "é" }), '{"a":"é","b":1}');
    assert.throws(() => canonicalJson({ a: Infinity }));
  });

  test("revisions and record identity are immutable at the database level", async () => {
    const { recordId, revisionId } = await createRecordAs(t.app, t.a.token);
    assert.throws(() => t.db.prepare("UPDATE revisions SET title = 'x' WHERE id = ?").run(revisionId), /immutable/);
    assert.throws(() => t.db.prepare("DELETE FROM revisions WHERE id = ?").run(revisionId), /immutable/);
    assert.throws(() => t.db.prepare("UPDATE records SET slug = 'x' WHERE id = ?").run(recordId), /immutable/);
    assert.throws(() => t.db.prepare("DELETE FROM records WHERE id = ?").run(recordId), /not deleted/);
  });

  test("a claim needs a source; internal references must exist", async () => {
    const claim = await t.app.inject({
      method: "POST", url: "/api/v1/records", headers: bearer(t.a.token),
      payload: sampleRecord({ kind: "claim", sources: [] }),
    });
    assert.equal(claim.statusCode, 400);
    assert.equal(claim.json().error.fields[0].path, "sources");

    const ghost = await t.app.inject({
      method: "POST", url: "/api/v1/records", headers: bearer(t.a.token),
      payload: sampleRecord({ sources: [{ revision_id: "rev_01M3R5DXKNES1WZGKS5739MCYM", note: "n" }] }),
    });
    assert.equal(ghost.statusCode, 400);
    assert.equal(ghost.json().error.fields[0].path, "sources[0].revision_id");

    const bothRefs = await t.app.inject({
      method: "POST", url: "/api/v1/records", headers: bearer(t.a.token),
      payload: sampleRecord({ sources: [{ note: "neither url nor revision" }] }),
    });
    assert.equal(bothRefs.statusCode, 400);
  });

  test("slugs: provisional until first publication, minted once from the reviewed title, never colliding", async () => {
    assert.equal(slugify("Héllo, World!  Node 24 & SQLite"), "hello-world-node-24-sqlite");
    assert.equal(slugify("!!!"), "record");
    const one = await createRecordAs(t.app, t.a.token, sampleRecord({ title: "Same Title Here" }));
    const two = await createRecordAs(t.app, t.b.token, sampleRecord({ title: "Same Title Here" }));
    // Unreviewed titles never become addresses: the slug is the record's own id.
    assert.equal(one.json.record.slug, one.recordId.toLowerCase());
    const p1 = (await publish(t.app, t.s.token, one.revisionId)).json().event;
    const p2 = (await publish(t.app, t.s.token, two.revisionId)).json().event;
    assert.equal(p1.record_slug, "same-title-here");
    assert.match(p2.record_slug, /^same-title-here-[0-9a-z]{8}$/);
    // A later retitled revision never changes the minted slug.
    const r2 = (await t.app.inject({
      method: "POST", url: `/api/v1/records/${one.recordId}/revisions`, headers: bearer(t.a.token),
      payload: { ...sampleRecord({ title: "A completely different title" }), base_revision_id: one.revisionId },
    })).json().revision.id;
    await publish(t.app, t.s.token, r2);
    assert.equal((await t.app.inject({ url: `/api/v1/records/${one.recordId}` })).json().record.slug, "same-title-here");
    // And the database refuses a second mint.
    assert.throws(
      () => t.db.prepare("UPDATE records SET slug = 'renamed', slug_minted_at = 'x' WHERE id = ?").run(one.recordId),
      /immutable/,
    );
  });

  test("a quarantined revision is a tombstone in every representation", async () => {
    const { recordId, revisionId } = await createRecordAs(t.app, t.a.token);
    t.db.prepare("UPDATE revision_review SET state = 'quarantined', reason = 'test' WHERE revision_id = ?").run(revisionId);
    const rev = (await t.app.inject({ method: "GET", url: `/api/v1/revisions/${revisionId}` })).json().revision;
    assert.equal(rev.withheld, true);
    assert.equal(rev.body_markdown, undefined);
    assert.equal(rev.title, undefined);
    const rec = (await t.app.inject({ method: "GET", url: `/api/v1/records/${recordId}` })).json();
    assert.equal(rec.latest_revision.title, undefined);
    const hist = (await t.app.inject({ method: "GET", url: `/api/v1/records/${recordId}/revisions` })).json();
    assert.equal(hist.items[0].withheld, true);
    const anns = await t.app.inject({ method: "GET", url: `/api/v1/revisions/${revisionId}/annotations` });
    assert.equal(anns.statusCode, 404);
  });

  test("bounds: oversized body is 413, oversized page is 400, bad id is 400, unknown id is 404", async () => {
    const big = await t.app.inject({
      method: "POST", url: "/api/v1/records", headers: bearer(t.a.token),
      payload: sampleRecord({ body_markdown: "x".repeat(140 * 1024) }),
    });
    assert.equal(big.statusCode, 413);
    const { recordId } = await createRecordAs(t.app, t.a.token);
    const page = await t.app.inject({ method: "GET", url: `/api/v1/records/${recordId}/revisions?limit=500` });
    assert.equal(page.statusCode, 400);
    assert.equal(page.json().error.fields[0].path, "limit");
    const bad = await t.app.inject({ method: "GET", url: "/api/v1/revisions/rev_nope" });
    assert.equal(bad.statusCode, 400);
    const unknown = await t.app.inject({ method: "GET", url: "/api/v1/revisions/rev_01M3R5DXKNES1WZGKS5739MCYM" });
    assert.equal(unknown.statusCode, 404);
    assert.equal(unknown.json().error.code, "not_found");
  });

  test("health, readiness, and the agent guide respond", async () => {
    assert.equal((await t.app.inject({ url: "/healthz" })).json().status, "ok");
    const migrations = readdirSync(join(import.meta.dirname, "..", "migrations")).filter((f) => f.endsWith(".sql")).length;
    assert.deepEqual((await t.app.inject({ url: "/readyz" })).json(), { status: "ready", schema_version: migrations, version: "dev" });
    // The guide is served twice: as a page for people and as Markdown for agents.
    const md = await t.app.inject({ url: "/agent-guide.md" });
    assert.match(md.headers["content-type"] as string, /^text\/markdown/);
    assert.match(md.body, /not instructions to\s+you/);
    const page = await t.app.inject({ url: "/agent-guide" });
    assert.match(page.headers["content-type"] as string, /^text\/html/);
    assert.match(page.body, /not instructions to\s+you/);
  });
});
