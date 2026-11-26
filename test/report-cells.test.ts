import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildNoosphereMcp } from "../mcp/server.ts";
import { getRevision } from "../src/modules/records.ts";
import { bearer, publishedRecord, sampleOutcome, setup } from "./helpers.ts";

// A reply on the founder's Hugging Face forum post (2026-11-17): reports that
// differ by conditions are not disagreements. Weigh them only inside one cell
// (same revision, materially the same conditions); a failure that names its
// check, met by "worked" reports there, marks the cell disputed. Shown and
// flagged, never hidden.
describe("outcome reports grouped by conditions", () => {
  let t: ReturnType<typeof setup>;
  let base: string;
  let slug: string;
  let rev: string;
  let ids: string[] = [];

  const report = async (token: string, payload: object) => {
    const res = await t.app.inject({ method: "POST", url: `/api/v1/revisions/${rev}/annotations`, headers: bearer(token), payload });
    assert.equal(res.statusCode, 201, res.body);
    return res.json().annotation.id as string;
  };
  const approve = (id: string) => t.app.inject({
    method: "POST", url: "/api/v1/admin/moderation-events", headers: bearer(t.s.token),
    payload: { action: "approve_annotation", target_id: id, reason: "ok" },
  });
  const get = async (url: string) => (await t.app.inject({ method: "GET", url })).json();

  before(async () => {
    t = setup();
    base = await t.app.listen({ host: "127.0.0.1", port: 0 });
    const r = await publishedRecord(t, t.a.token, {
      title: "Record with reports under two conditions",
      conditions: { os: "Ubuntu 24.04", node: "24.19", date: "2026-10-01" },
    });
    ({ slug } = r);
    rev = r.revisionId;
    // Ubuntu 24.04 / node 24.19: two worked (one by each contributor), one checked failure: disputed.
    ids.push(await report(t.a.token, sampleOutcome({ conditions: { os: "Ubuntu 24.04", node: "24.19.0", date: "2026-11-01" } })));
    ids.push(await report(t.b.token, sampleOutcome({ conditions: { os: "ubuntu-24.04.1", node: "v24.19.3", date: "2026-11-02" } })));
    ids.push(await report(t.b.token, sampleOutcome({ outcome: "failed", conditions: { os: "Ubuntu 24.04", node: "24.19.1" } })));
    // Debian 12, node not stated: worked once.
    ids.push(await report(t.a.token, sampleOutcome({ conditions: { os: "Debian 12", observed: "2026-11-03" } })));
    for (const id of ids) await approve(id);
    // A candidate failure in the Debian cell: never counted.
    await report(t.b.token, sampleOutcome({ outcome: "failed", conditions: { os: "Debian 12" } }));
  });
  after(() => t.close());

  test("report-history carries the cells, disputed first; candidates excluded", async () => {
    const h = await get(`/api/v1/revisions/${rev}/report-history`);
    const bc = h.this_revision.by_conditions;
    assert.deepEqual(bc.grouped_by, ["os", "node"]);
    assert.equal(bc.cells.length, 2);
    const [d, w] = bc.cells;
    assert.equal(d.verdict, "disputed");
    assert.equal(d.label, "os Ubuntu 24.04 · node 24.19.0");
    assert.deepEqual(d.outcomes, { worked: 2, failed: 1 });
    assert.equal(d.contributors, 2);
    assert.equal(w.verdict, "worked", "the candidate failure was counted");
    assert.equal(w.label, "os Debian 12 · node not stated");
    assert.deepEqual(w.outcomes, { worked: 1 });
    // The existing tally is unchanged beside it.
    assert.deepEqual(h.this_revision.outcomes, { worked: 3, failed: 1 });
    assert.deepEqual(Object.keys(h.this_revision), ["outcomes", "outcomes_with_check", "outcomes_with_stated_check", "latest", "by_conditions"]);
  });

  test("the page shows one line per cell, the disputed one first and marked", async () => {
    const body = (await t.app.inject({ method: "GET", url: `/r/${slug}` })).body;
    const disputed = body.indexOf('<span class="badge disputed">disputed</span> os Ubuntu 24.04 · node 24.19.0: worked 2 (all with a check), failed 1 (with a check)');
    const debian = body.indexOf("os Debian 12 · node not stated: worked 1 (with a check) · holds here");
    assert.ok(disputed > 0, "disputed cell missing");
    assert.ok(debian > disputed, "disputed cell is not first");
    assert.match(body, /disputed: re-run the check to settle it/);
    assert.match(body, /Not reported under any other conditions\./);
    assert.match(body, /Counts are reports from contributors, not verification/);
    assert.ok(!/worked 3 \(/.test(body), "the old single tally is still shown");
    assert.match(body, /1 unreviewed report awaiting review/);
  });

  test("revision JSON and Markdown carry by_conditions; existing fields unchanged", async () => {
    const json = await get(`/api/v1/revisions/${rev}`);
    assert.equal(json.by_conditions.cells[0].verdict, "disputed");
    const { by_conditions: _b, ...rest } = json;
    assert.deepEqual(rest, JSON.parse(JSON.stringify(getRevision(t.db, rev))), "an existing field changed");
    const md = (await t.app.inject({ method: "GET", url: `/api/v1/revisions/${rev}/markdown` })).body;
    const line = md.split("\n").find((l) => l.startsWith("by_conditions: "))!;
    assert.equal(JSON.parse(line.slice("by_conditions: ".length)).cells[0].verdict, "disputed");
  });

  test("a withheld revision gives no cells", async () => {
    const r2 = await publishedRecord(t, t.a.token, { title: "Record that gets quarantined" });
    t.db.prepare("UPDATE revision_review SET state = 'quarantined' WHERE revision_id = ?").run(r2.revisionId);
    const json = await get(`/api/v1/revisions/${r2.revisionId}`);
    assert.equal(json.revision.withheld, true);
    assert.equal(json.by_conditions, undefined);
  });

  test("get_revision over MCP carries by_conditions", async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = buildNoosphereMcp({ base });
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
    const out = (await client.callTool({ name: "get_revision", arguments: { revision_id: rev } })).content as { text: string }[];
    const text = out.map((c) => c.text).join("\n");
    const json = JSON.parse(text.slice(text.indexOf("\n") + 1));
    assert.equal(json.by_conditions.cells[0].verdict, "disputed");
    assert.equal(json.report_history.this_revision.by_conditions.cells.length, 2);
  });
});
