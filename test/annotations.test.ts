import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { annotationHash } from "../src/hash.ts";
import { bearer, createRecordAs, sampleOutcome, setup } from "./helpers.ts";

describe("annotations on exact revisions", () => {
  let t: ReturnType<typeof setup>;
  let revisionId: string;
  before(async () => {
    t = setup();
    ({ revisionId } = await createRecordAs(t.app, t.a.token));
  });
  after(() => t.close());

  const post = (token: string, payload: unknown, rev = revisionId) =>
    t.app.inject({ method: "POST", url: `/api/v1/revisions/${rev}/annotations`, headers: bearer(token), payload: payload as object });

  test("B's outcome report targets A's exact revision, authored by B", async () => {
    const res = await post(t.b.token, sampleOutcome());
    assert.equal(res.statusCode, 201);
    const ann = res.json().annotation;
    assert.equal(ann.revision_id, revisionId);
    assert.equal(ann.author_id, t.b.id);
    assert.notEqual(ann.author_id, t.a.id);
    assert.equal(ann.outcome, "worked");
    assert.equal(ann.review_state, "candidate");
    assert.deepEqual(ann.check, sampleOutcome().check);
    assert.equal(ann.hash_schema, "noosphere-annotation/2");
    assert.equal(
      annotationHash({
        id: ann.id, revision_id: ann.revision_id, author_id: ann.author_id, kind: ann.kind,
        outcome: ann.outcome, body: ann.body, evidence: ann.evidence, conditions: ann.conditions,
        check: ann.check, supersedes_annotation_id: ann.supersedes_annotation_id, created_at: ann.created_at,
      }, ann.hash_schema),
      ann.content_hash,
    );
  });

  test("an outcome report must be a real observation", async () => {
    const cases: [object, string][] = [
      [sampleOutcome({ outcome: undefined }), "outcome"],
      [{ ...sampleOutcome(), outcome: "great" }, "outcome"],
      [sampleOutcome({ body: "+1 works" }), "body"],
      [sampleOutcome({ conditions: {} }), "conditions"],
      [{ kind: "critique", outcome: "worked", body: "A critique does not carry an outcome." }, "outcome"],
      [{ ...sampleOutcome(), author_id: t.a.id }, "author_id"],
      [{ ...sampleOutcome(), revision_id: revisionId }, "revision_id"],
    ];
    for (const [payload, field] of cases) {
      const res = await post(t.b.token, payload);
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
      assert.equal(res.json().error.fields[0].path, field, JSON.stringify(payload));
    }
  });

  test("unknown revision is 404; anonymous annotation is 401", async () => {
    assert.equal((await post(t.b.token, sampleOutcome(), "rev_01M3R5DXKNES1WZGKS5739MCYM")).statusCode, 404);
    const anon = await t.app.inject({ method: "POST", url: `/api/v1/revisions/${revisionId}/annotations`, payload: sampleOutcome() });
    assert.equal(anon.statusCode, 401);
  });

  test("default listing shows reviewed only; candidates only when asked, labeled", async () => {
    const dflt = (await t.app.inject({ url: `/api/v1/revisions/${revisionId}/annotations` })).json();
    assert.deepEqual(dflt.included_states, ["reviewed"]);
    assert.equal(dflt.items.length, 0);
    const withCand = (await t.app.inject({ url: `/api/v1/revisions/${revisionId}/annotations?include=candidate` })).json();
    assert.ok(withCand.items.length >= 1);
    assert.ok(withCand.items.every((a: { review_state: string }) => a.review_state === "candidate"));
    // Once reviewed, it appears by default.
    const first = withCand.items[0].id;
    t.db.prepare("UPDATE annotation_review SET state = 'reviewed' WHERE annotation_id = ?").run(first);
    const after = (await t.app.inject({ url: `/api/v1/revisions/${revisionId}/annotations` })).json();
    assert.deepEqual(after.items.map((a: { id: string }) => a.id), [first]);
    // Quarantined annotations vanish from both views.
    t.db.prepare("UPDATE annotation_review SET state = 'quarantined' WHERE annotation_id = ?").run(first);
    const q = (await t.app.inject({ url: `/api/v1/revisions/${revisionId}/annotations?include=candidate` })).json();
    assert.ok(!q.items.some((a: { id: string }) => a.id === first));
  });

  test("supersede only your own annotation on the same revision", async () => {
    const mine = (await post(t.b.token, sampleOutcome({ outcome: "failed" }))).json().annotation;
    const fix = await post(t.b.token, sampleOutcome({ supersedes_annotation_id: mine.id }));
    assert.equal(fix.statusCode, 201);
    const theirs = await post(t.a.token, sampleOutcome({ supersedes_annotation_id: mine.id }));
    assert.equal(theirs.statusCode, 400);
    assert.equal(theirs.json().error.fields[0].path, "supersedes_annotation_id");
    // The original report is preserved untouched.
    const orig = (await t.app.inject({ url: `/api/v1/revisions/${revisionId}/annotations?include=candidate&limit=50` }))
      .json().items.find((a: { id: string }) => a.id === mine.id);
    assert.equal(orig.outcome, "failed");
  });

  test("annotations are immutable at the database level", () => {
    const id = t.db.prepare("SELECT id FROM annotations LIMIT 1").pluck().get();
    assert.throws(() => t.db.prepare("UPDATE annotations SET outcome = 'failed' WHERE id = ?").run(id), /immutable/);
    assert.throws(() => t.db.prepare("DELETE FROM annotations WHERE id = ?").run(id), /immutable/);
  });

  test("cursor pagination walks every candidate exactly once", async () => {
    const { revisionId: rev } = await createRecordAs(t.app, t.a.token);
    const made: string[] = [];
    for (let i = 0; i < 5; i++) made.push((await post(t.b.token, sampleOutcome(), rev)).json().annotation.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const qs: string = `limit=2&include=candidate${cursor ? `&cursor=${cursor}` : ""}`;
      const page = (await t.app.inject({ url: `/api/v1/revisions/${rev}/annotations?${qs}` })).json();
      assert.ok(page.items.length <= 2);
      seen.push(...page.items.map((a: { id: string }) => a.id));
      cursor = page.next_cursor;
    } while (cursor);
    assert.deepEqual(seen, made);
  });
});
