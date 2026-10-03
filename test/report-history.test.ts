import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildNoosphereMcp } from "../mcp/server.ts";
import { bearer, propose, publish, publishedRecord, sampleOutcome, setup } from "./helpers.ts";

// Asked on r/mcp: when a how-to goes stale and a newer revision supersedes it,
// does an agent find out? Two gaps closed (v0.1.12):
// 1. an old revision names the record's current one (current_revision_id);
// 2. a revision shows reports on the record's OTHER revisions, clearly apart
//    from its own, because a new revision starts with none.
describe("report history across a record's revisions", () => {
  let t: ReturnType<typeof setup>;
  let base: string;
  let slug: string;
  let rev1: string;
  let rev2: string;
  let worked1: string;
  let worked2: string;
  let failed: string;

  const report = async (rev: string, payload: object) =>
    (await t.app.inject({ method: "POST", url: `/api/v1/revisions/${rev}/annotations`, headers: bearer(t.b.token), payload })).json().annotation.id as string;
  const approve = (id: string) => t.app.inject({
    method: "POST", url: "/api/v1/admin/moderation-events", headers: bearer(t.s.token),
    payload: { action: "approve_annotation", target_id: id, reason: "ok" },
  });
  const get = async (url: string) => (await t.app.inject({ method: "GET", url })).json();

  before(async () => {
    t = setup();
    base = await t.app.listen({ host: "127.0.0.1", port: 0 });
    const r = await publishedRecord(t, t.a.token, { title: "Record that gets revised" });
    ({ slug } = r);
    rev1 = r.revisionId;
    worked1 = await report(rev1, sampleOutcome({ conditions: { node: "24.19.0" } }));
    worked2 = await report(rev1, sampleOutcome({ conditions: { node: "24.20.0" } }));
    failed = await report(rev1, sampleOutcome({ outcome: "failed", conditions: { node: "26.0.0" } }));
    for (const id of [worked1, worked2, failed]) await approve(id);
    await report(rev1, sampleOutcome({ outcome: "failed", conditions: { node: "unreviewed" } })); // stays a candidate
    rev2 = (await propose(t.app, t.a.token, r.recordId, rev1, { title: "Record that gets revised, for node 26" })).json().revision.id;
    await publish(t.app, t.s.token, rev2);
  });
  after(() => t.close());

  test("an old revision names the record's current one, in JSON and Markdown", async () => {
    const old = (await get(`/api/v1/revisions/${rev1}`)).revision;
    assert.equal(old.is_current_published, false);
    assert.equal(old.current_revision_id, rev2);
    assert.equal((await get(`/api/v1/revisions/${rev2}`)).revision.current_revision_id, rev2);
    const md = (await t.app.inject({ method: "GET", url: `/api/v1/revisions/${rev1}/markdown` })).body;
    assert.match(md, new RegExp(`current_revision_id: "${rev2}"`));
  });

  test("the new revision's own reports stay empty; the old ones are history, apart", async () => {
    const h = await get(`/api/v1/revisions/${rev2}/report-history`);
    assert.deepEqual(h.this_revision.outcomes, {}, "reports on rev1 were counted as reports about rev2");
    assert.equal((await get(`/api/v1/revisions/${rev2}/annotations`)).items.length, 0);
    assert.equal(h.other_revisions.length, 1);
    const o = h.other_revisions[0];
    assert.equal(o.revision_id, rev1);
    assert.equal(o.is_current_published, false);
    assert.deepEqual(o.outcomes, { worked: 2, failed: 1 }, "the unreviewed report was counted");
    assert.deepEqual(o.outcomes_with_check, { worked: 2, failed: 1 });
    assert.equal(o.latest.worked.report_id, worked2, "latest is not the newest report");
    assert.deepEqual(o.latest.failed.conditions, { node: "26.0.0" });
    assert.match(h.notice, /not reports about this revision/);
  });

  test("seen from the old revision, its own reports count and the current one is named", async () => {
    const h = await get(`/api/v1/revisions/${rev1}/report-history`);
    assert.deepEqual(h.this_revision.outcomes, { worked: 2, failed: 1 });
    assert.equal(h.current_revision_id, rev2);
    assert.deepEqual(h.other_revisions, [], "rev2 has no reports, so it is not listed");
  });

  test("the page shows other revisions' reports under their own heading", async () => {
    const body = (await t.app.inject({ method: "GET", url: `/r/${slug}` })).body;
    assert.match(body, /No reviewed outcome reports yet/);
    assert.match(body, /Reports on other revisions of this record/);
    assert.match(body, new RegExp(`href="/r/${slug}/revisions/${rev1}">${rev1}</a>: worked 2, failed 1 · last failed`));
  });

  test("get_revision over MCP names the current revision and carries the history", async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = buildNoosphereMcp({ base });
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
    const text = (r: any) => (r.content as { text: string }[]).map((c) => c.text).join("\n");
    const old = text(await client.callTool({ name: "get_revision", arguments: { revision_id: rev1 } }));
    assert.match(old.split("\n")[0]!, new RegExp(`not the record's current revision; the current one is ${rev2}`));
    const now = text(await client.callTool({ name: "get_revision", arguments: { revision_id: rev2 } }));
    assert.ok(!/not the record's current revision/.test(now.split("\n")[0]!));
    const json = JSON.parse(now.slice(now.indexOf("\n") + 1));
    assert.equal(json.report_history.other_revisions[0].revision_id, rev1);
    assert.match(json.report_history.notice, /not reports about this revision/);
  });

  test("quarantined revisions and reports never appear in the history", async () => {
    t.db.prepare("UPDATE annotation_review SET state = 'quarantined' WHERE annotation_id = ?").run(failed);
    let o = (await get(`/api/v1/revisions/${rev2}/report-history`)).other_revisions[0];
    assert.deepEqual(o.outcomes, { worked: 2 });
    t.db.prepare("UPDATE revision_review SET state = 'quarantined' WHERE revision_id = ?").run(rev1);
    o = (await get(`/api/v1/revisions/${rev2}/report-history`)).other_revisions;
    assert.deepEqual(o, [], "a quarantined revision's reports leaked into the history");
    const res = await t.app.inject({ method: "GET", url: `/api/v1/revisions/${rev1}/report-history` });
    assert.equal(res.statusCode, 404);
  });
});
