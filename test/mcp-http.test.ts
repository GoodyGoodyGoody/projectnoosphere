import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ipHash } from "../src/limits.ts";
import { createRecordAs, publish, sampleRecord, setup } from "./helpers.ts";

// The hosted endpoint (POST /mcp, src/mcp-http.ts), driven by the SDK's own
// HTTP client against a real listening app.
const realFetch = globalThis.fetch;

describe("hosted MCP endpoint", () => {
  let outbound: string[];
  // The server must never call out. While these tests run, any use of the
  // GLOBAL fetch records the attempt and fails; only the test's client has
  // the real one.
  const forbidOutbound = () => {
    outbound = [];
    globalThis.fetch = (async (input: unknown) => {
      outbound.push(String(input instanceof Request ? input.url : input));
      throw new Error("outbound request from the server");
    }) as typeof fetch;
  };
  afterEach(() => { globalThis.fetch = realFetch; });

  const connect = async (base: string, headers: Record<string, string> = {}) => {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { fetch: realFetch, requestInit: { headers } }));
    return client;
  };
  const textOf = (r: any) => (r.content as { text: string }[]).map((c) => c.text).join("\n");
  // Total writes counted against one client address, across its windows.
  const writesBy = (t: ReturnType<typeof setup>, ip: string) =>
    (t.db.prepare("SELECT COALESCE(SUM(count), 0) n FROM rate_limits WHERE bucket LIKE ?").get(`w:ip:${ipHash(t.db, ip)}:h`) as { n: number }).n;

  describe("behind a trusted proxy", () => {
    let t: ReturnType<typeof setup>;
    let base: string;
    let published: string;
    before(async () => {
      t = setup({ trustProxy: "127.0.0.1" });
      base = await t.app.listen({ host: "127.0.0.1", port: 0 });
      published = (await createRecordAs(t.app, t.a.token, sampleRecord({ title: "Quokka hosted endpoint record" }))).revisionId;
      await publish(t.app, t.s.token, published);
    });
    after(() => t.close());

    test("lists the six tools and answers a search entirely in-process", async () => {
      forbidOutbound();
      const client = await connect(base);
      const tools = (await client.listTools()).tools.map((x) => x.name).sort();
      assert.deepEqual(tools, ["annotate", "create_record", "get_revision", "propose_revision", "report_outcome", "search"]);
      const out = textOf(await client.callTool({ name: "search", arguments: { query: "quokka" } }));
      assert.match(out, /^Contributed content from Project Noosphere/);
      assert.ok(out.includes(published));
      assert.deepEqual(outbound, [], "the server made an outbound request");
    });

    test("a write carries the caller's token and is rate-limited as the caller's own address", async () => {
      forbidOutbound();
      const before = { client: writesBy(t, "203.0.113.7"), proxy: writesBy(t, "127.0.0.1") };
      const client = await connect(base, { authorization: `Bearer ${t.b.token}`, "x-forwarded-for": "203.0.113.7" });
      const r = await client.callTool({
        name: "report_outcome",
        arguments: { revision_id: published, outcome: "worked", body: "Followed it through the hosted endpoint and it worked as written.", conditions: { os: "Ubuntu 24.04" } },
      });
      assert.equal(r.isError, undefined, textOf(r));
      const id = textOf(r).match(/ann_[0-9A-Z]{26}/)![0];
      const row = t.db.prepare("SELECT author_id, revision_id FROM annotations WHERE id = ?").get(id) as any;
      assert.deepEqual(row, { author_id: t.b.id, revision_id: published });
      assert.equal(writesBy(t, "203.0.113.7"), before.client + 1, "the write was not counted against the forwarded client address");
      assert.equal(writesBy(t, "127.0.0.1"), before.proxy, "the write was counted against the proxy instead of the client");
      assert.deepEqual(outbound, []);
    });

    test("without a token, writes explain how to get one", async () => {
      const r = await (await connect(base)).callTool({
        name: "report_outcome",
        arguments: { revision_id: published, outcome: "failed", body: "x".repeat(60), conditions: { os: "x" } },
      });
      assert.equal(r.isError, true);
      assert.match(textOf(r), /needs a Noosphere token/);
    });

    test("an oversized write comes back as a tool error, not a broken transport", async () => {
      // 100k quote characters: within the field limit, but the escaped JSON is
      // over the API's 128 KiB body limit. /mcp itself accepts it.
      const r = await (await connect(base, { authorization: `Bearer ${t.a.token}` })).callTool({
        name: "create_record",
        arguments: { kind: "observation", title: "Oversized through the hosted endpoint", summary: "s", body_markdown: "\"".repeat(100_000) },
      });
      assert.equal(r.isError, true);
      assert.match(textOf(r), /Noosphere API 413/);
    });

    test("GET and DELETE are 405 with Allow: POST", async () => {
      for (const method of ["GET", "DELETE"] as const) {
        const res = await t.app.inject({ method, url: "/mcp" });
        assert.equal(res.statusCode, 405);
        assert.equal(res.headers.allow, "POST");
      }
    });
  });

  describe("with no trusted proxy", () => {
    let t: ReturnType<typeof setup>;
    let base: string;
    before(async () => {
      t = setup();
      base = await t.app.listen({ host: "127.0.0.1", port: 0 });
    });
    after(() => t.close());

    test("a client's own X-Forwarded-For changes nothing", async () => {
      const rev = (await createRecordAs(t.app, t.a.token, sampleRecord({ title: "Spoofed forwarding test" }))).revisionId;
      const before = { spoofed: writesBy(t, "198.51.100.9"), peer: writesBy(t, "127.0.0.1") };
      const client = await connect(base, { authorization: `Bearer ${t.b.token}`, "x-forwarded-for": "198.51.100.9" });
      const r = await client.callTool({
        name: "annotate", arguments: { revision_id: rev, kind: "question", body: "Does this apply on arm64 as well?" },
      });
      assert.equal(r.isError, undefined, textOf(r));
      assert.equal(writesBy(t, "198.51.100.9"), before.spoofed, "a spoofed header chose the rate-limit bucket");
      assert.equal(writesBy(t, "127.0.0.1"), before.peer + 1, "the write was not counted against the real peer");
    });
  });
});
