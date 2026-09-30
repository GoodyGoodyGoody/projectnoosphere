import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { revisionHash } from "../src/hash.ts";
import { bearer, count, createRecordAs, propose, publish, sampleOutcome, sampleRecord, setup } from "./helpers.ts";

describe("revision proposals, publication, and stale bases", () => {
  let t: ReturnType<typeof setup>;
  before(() => { t = setup(); });
  after(() => t.close());

  test("an unpublished record takes proposals against base null; any other base is stale", async () => {
    const { recordId, revisionId } = await createRecordAs(t.app, t.a.token);
    const ok = await propose(t.app, t.b.token, recordId, null, { title: "Alternative first draft" });
    assert.equal(ok.statusCode, 201);
    assert.equal(ok.headers.location, `/api/v1/revisions/${ok.json().revision.id}`);
    assert.equal(ok.json().revision.base_revision_id, null);
    assert.equal(ok.json().revision.author_id, t.b.id);
    const stale = await propose(t.app, t.b.token, recordId, revisionId);
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, "stale_base");
    assert.deepEqual(stale.json().error.details, { current_revision_id: null, your_base_revision_id: revisionId });
  });

  test("base_revision_id is required, even when null", async () => {
    const { recordId } = await createRecordAs(t.app, t.a.token);
    const res = await t.app.inject({
      method: "POST", url: `/api/v1/records/${recordId}/revisions`, headers: bearer(t.a.token), payload: sampleRecord(),
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.fields[0].path, "base_revision_id");
  });

  test("only a steward can publish; publishing moves the pointer and is logged", async () => {
    const { recordId, revisionId } = await createRecordAs(t.app, t.a.token);
    const denied = await publish(t.app, t.a.token, revisionId);
    assert.equal(denied.statusCode, 403);
    const events = count(t.db, "moderation_events");
    const res = await publish(t.app, t.s.token, revisionId);
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().event.published_revision_id, revisionId);
    assert.equal(count(t.db, "moderation_events"), events + 1);
    const ev = t.db.prepare("SELECT actor_id, action, target_id FROM moderation_events ORDER BY id DESC LIMIT 1").get();
    assert.deepEqual(ev, { actor_id: t.s.id, action: "publish_revision", target_id: revisionId });
    const rec = (await t.app.inject({ url: `/api/v1/records/${recordId}` })).json();
    assert.equal(rec.record.published, true);
    assert.equal(rec.current_revision.id, revisionId);
    assert.equal(rec.current_revision.review_state, "reviewed");
    const again = await publish(t.app, t.s.token, revisionId);
    assert.equal(again.statusCode, 409);
    assert.equal(again.json().error.code, "not_candidate");
  });

  test("two competing candidates on one base: the first publish wins, the second is a 409", async () => {
    const { recordId, revisionId: r1 } = await createRecordAs(t.app, t.a.token);
    await publish(t.app, t.s.token, r1);
    const c1 = (await propose(t.app, t.a.token, recordId, r1, { title: "Edit by A" })).json().revision.id;
    const c2 = (await propose(t.app, t.b.token, recordId, r1, { title: "Edit by B" })).json().revision.id;
    assert.equal((await publish(t.app, t.s.token, c1)).statusCode, 201);
    const loser = await publish(t.app, t.s.token, c2);
    assert.equal(loser.statusCode, 409);
    assert.equal(loser.json().error.code, "stale_base");
    assert.equal(loser.json().error.details.current_revision_id, c1);
    const rec = (await t.app.inject({ url: `/api/v1/records/${recordId}` })).json();
    assert.equal(rec.record.current_revision_id, c1);
    // The loser is still a candidate, and a proposal against the old base is refused.
    assert.equal((await t.app.inject({ url: `/api/v1/revisions/${c2}` })).json().revision.review_state, "candidate");
    const late = await propose(t.app, t.b.token, recordId, r1);
    assert.equal(late.statusCode, 409);
    assert.equal(late.json().error.details.current_revision_id, c1);
  });

  test("a correction leaves the original revision and its report intact", async () => {
    const { recordId, revisionId: r1 } = await createRecordAs(t.app, t.a.token);
    const report = (await t.app.inject({
      method: "POST", url: `/api/v1/revisions/${r1}/annotations`, headers: bearer(t.b.token),
      payload: sampleOutcome({ outcome: "partially_worked" }),
    })).json().annotation;
    await publish(t.app, t.s.token, r1);
    const r2 = (await propose(t.app, t.b.token, recordId, r1, { title: "Corrected procedure" })).json().revision.id;
    await publish(t.app, t.s.token, r2);

    const old = (await t.app.inject({ url: `/api/v1/revisions/${r1}` })).json().revision;
    assert.equal(old.review_state, "reviewed");
    assert.equal(old.is_current_published, false);
    assert.equal(old.content_hash, revisionHash({
      id: old.id, record_id: old.record_id, base_revision_id: old.base_revision_id,
      parent_revision_id: old.parent_revision_id, author_id: old.author_id, kind: old.kind, title: old.title,
      summary: old.summary, body_markdown: old.body_markdown, tags: old.tags, sources: old.sources,
      conditions: old.conditions, links: old.links, content_license: old.content_license, created_at: old.created_at,
    }));
    const anns = (await t.app.inject({ url: `/api/v1/revisions/${r1}/annotations?include=candidate` })).json();
    assert.equal(anns.items[0].id, report.id);
    assert.equal(anns.items[0].revision_id, r1);
    assert.equal(anns.items[0].outcome, "partially_worked");
    const onNew = (await t.app.inject({ url: `/api/v1/revisions/${r2}/annotations?include=candidate` })).json();
    assert.equal(onNew.items.length, 0, "a report on r1 never migrates to r2");
    const hist = (await t.app.inject({ url: `/api/v1/records/${recordId}/revisions` })).json();
    assert.deepEqual(hist.items.map((r: { id: string }) => r.id), [r1, r2]);
    assert.equal(hist.items[1].base_revision_id, r1);
  });

  test("parent_revision_id must belong to the same record", async () => {
    const one = await createRecordAs(t.app, t.a.token);
    const other = await createRecordAs(t.app, t.a.token);
    const res = await t.app.inject({
      method: "POST", url: `/api/v1/records/${one.recordId}/revisions`, headers: bearer(t.a.token),
      payload: { ...sampleRecord(), base_revision_id: null, parent_revision_id: other.revisionId },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.fields[0].path, "parent_revision_id");
  });

  test("approving an annotation shows it by default; approval is steward-only and once", async () => {
    const { revisionId } = await createRecordAs(t.app, t.a.token);
    const ann = (await t.app.inject({
      method: "POST", url: `/api/v1/revisions/${revisionId}/annotations`, headers: bearer(t.b.token), payload: sampleOutcome(),
    })).json().annotation;
    const approve = (token: string) => t.app.inject({
      method: "POST", url: "/api/v1/admin/moderation-events", headers: bearer(token),
      payload: { action: "approve_annotation", target_id: ann.id, reason: "useful, specific" },
    });
    assert.equal((await approve(t.b.token)).statusCode, 403);
    assert.equal((await approve(t.s.token)).statusCode, 201);
    assert.equal((await approve(t.s.token)).statusCode, 409);
    const list = (await t.app.inject({ url: `/api/v1/revisions/${revisionId}/annotations` })).json();
    assert.deepEqual(list.items.map((a: { id: string }) => a.id), [ann.id]);
    const mismatch = await t.app.inject({
      method: "POST", url: "/api/v1/admin/moderation-events", headers: bearer(t.s.token),
      payload: { action: "publish_revision", target_id: ann.id, reason: "wrong target type" },
    });
    assert.equal(mismatch.statusCode, 400);
    assert.equal(mismatch.json().error.fields[0].path, "target_id");
  });
});
