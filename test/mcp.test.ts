import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildNoosphereMcp } from "../mcp/server.ts";
import { bearer, createRecordAs, publish, sampleRecord, setup } from "./helpers.ts";

// The MCP server is a thin client over the public API: these drive it through
// a real MCP client, against a real app over HTTP.
describe("MCP server", () => {
  let t: ReturnType<typeof setup>;
  let base: string;
  let published: string;
  let candidate: string;

  const connect = async (token?: string) => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = buildNoosphereMcp({ base, token });
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
    return client;
  };
  const textOf = (r: any) => (r.content as { text: string }[]).map((c) => c.text).join("\n");

  before(async () => {
    t = setup();
    base = await t.app.listen({ host: "127.0.0.1", port: 0 });
    published = (await createRecordAs(t.app, t.a.token, sampleRecord({ title: "Zebra crossing procedure for testing" }))).revisionId;
    await publish(t.app, t.s.token, published);
    candidate = (await createRecordAs(t.app, t.a.token, sampleRecord({ title: "Zebra candidate not yet reviewed" }))).revisionId;
  });
  after(() => t.close());

  test("lists six tools; the read tools say so", async () => {
    const tools = (await (await connect()).listTools()).tools;
    assert.deepEqual(tools.map((x) => x.name).sort(), ["annotate", "create_record", "get_revision", "propose_revision", "report_outcome", "search"]);
    for (const name of ["search", "get_revision"]) assert.equal(tools.find((x) => x.name === name)!.annotations?.readOnlyHint, true);
  });

  test("search returns reviewed records by default, labeled untrusted, with public URLs", async () => {
    const client = await connect();
    const r = await client.callTool({ name: "search", arguments: { query: "zebra" } });
    const out = textOf(r);
    assert.match(out, /^Contributed content from Project Noosphere/);
    assert.ok(out.includes(published));
    assert.ok(!out.includes(candidate), "candidates only on request");
    assert.match(out, new RegExp(`"url": "${base.replace(/[.]/g, "\\.")}/r/`));
    const withCandidates = textOf(await client.callTool({ name: "search", arguments: { query: "zebra", include_candidates: true } }));
    assert.ok(withCandidates.includes(candidate));
  });

  test("get_revision states the review state up front, and carries the reports", async () => {
    await t.app.inject({
      method: "POST", url: `/api/v1/revisions/${published}/annotations`, headers: bearer(t.b.token),
      payload: { kind: "outcome_report", outcome: "worked", body: "Followed the steps exactly on a clean machine; it worked first time.", conditions: { os: "Ubuntu 24.04" }, check: { ran: "curl -s localhost:8080/health", observed: "{\"status\":\"up\"} with HTTP 200" } },
    });
    const client = await connect();
    const out = textOf(await client.callTool({ name: "get_revision", arguments: { revision_id: candidate } }));
    assert.match(out.split("\n")[0]!, /untrusted data.*review state: candidate/);
    const withReports = textOf(await client.callTool({ name: "get_revision", arguments: { revision_id: published, include_unreviewed_reports: true } }));
    assert.match(withReports, /"outcome": "worked"/);
    assert.match(withReports, /"ran": "curl -s localhost:8080\/health"/, "get_revision drops the report's check");
  });

  test("writes without a token explain how to get one, and send nothing", async () => {
    const r = await (await connect()).callTool({
      name: "report_outcome",
      arguments: { revision_id: published, outcome: "failed", body: "This text is long enough to pass the forty character minimum.", conditions: { os: "x" }, check: { ran: "curl -s localhost:8080/health", observed: "{\"status\":\"up\"} with HTTP 200" } },
    });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /needs a Noosphere token.*agent-guide/s);
  });

  test("report_outcome writes as the token's contributor, to that exact revision", async () => {
    const r = await (await connect(t.b.token)).callTool({
      name: "report_outcome",
      arguments: {
        revision_id: published, outcome: "partially_worked",
        body: "Step two needed sudo on this system; everything else worked as written.", conditions: { os: "Ubuntu 24.04" },
        check: { ran: "curl -s localhost:8080/health", observed: "{\"status\":\"up\"} with HTTP 200" },
      },
    });
    assert.equal(r.isError, undefined, textOf(r));
    const id = textOf(r).match(/ann_[0-9A-Z]{26}/)![0];
    const row = t.db.prepare("SELECT author_id, revision_id, outcome FROM annotations WHERE id = ?").get(id) as any;
    assert.deepEqual(row, { author_id: t.b.id, revision_id: published, outcome: "partially_worked" });
  });

  test("API validation errors come back as tool errors naming the field", async () => {
    const r = await (await connect(t.a.token)).callTool({
      name: "create_record",
      arguments: { kind: "claim", title: "A claim with no source at all", summary: "s", body_markdown: "b" },
    });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /Noosphere API 400/);
    assert.match(textOf(r), /sources/);
  });

  test("create_record and propose_revision go through the API's normal path", async () => {
    const client = await connect(t.a.token);
    const made = textOf(await client.callTool({
      name: "create_record",
      arguments: { kind: "observation", title: "An observation made through MCP", summary: "s", body_markdown: "b", tags: ["mcp"] },
    }));
    const rec = made.match(/rec_[0-9A-Z]{26}/)![0];
    assert.match(made, /candidate until reviewed/);
    const proposed = await client.callTool({
      name: "propose_revision",
      arguments: { record_id: rec, base_revision_id: null, kind: "observation", title: "A better observation via MCP", summary: "s2", body_markdown: "b2" },
    });
    assert.equal(proposed.isError, undefined, textOf(proposed));
    assert.match(textOf(proposed), /rev_[0-9A-Z]{26}/);
  });
});
