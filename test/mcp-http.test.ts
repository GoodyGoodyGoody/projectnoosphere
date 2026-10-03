import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client as ModernClient, StreamableHTTPClientTransport as ModernTransport } from "@modelcontextprotocol/client";
import { ipHash } from "../src/limits.ts";
import { createRecordAs, publish, sampleRecord, setup } from "./helpers.ts";

// The hosted endpoint (/mcp, src/mcp-http.ts), driven by real MCP clients
// against a real listening app, in BOTH protocol eras: the v1 SDK's client
// (2025-era handshake) and a v2 client pinned to 2026-07-28, the revision
// that SDK v1 turned away (Sentry PROJECTNOOSPHERE-5). Every test below runs
// once per era.
const realFetch = globalThis.fetch;
const ERAS = ["2025 era (v1 client)", "2026-07-28 (v2 client, pinned)"] as const;

for (const era of ERAS) describe(`hosted MCP endpoint, ${era}`, () => {
  const modern = era.startsWith("2026");
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

  const connect = async (base: string, headers: Record<string, string> = {}): Promise<any> => {
    const url = new URL(`${base}/mcp`);
    if (modern) {
      const client = new ModernClient({ name: "test", version: "0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
      await client.connect(new ModernTransport(url, { fetch: realFetch, requestInit: { headers } }));
      assert.equal(client.getProtocolEra(), "modern");
      return client;
    }
    const client = new LegacyClient({ name: "test", version: "0" });
    await client.connect(new LegacyTransport(url, { fetch: realFetch, requestInit: { headers } }));
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

    test("tool schemas keep their required fields and read-only hints", async () => {
      const tools = (await (await connect(base)).listTools()).tools as any[];
      const report = tools.find((x) => x.name === "report_outcome");
      for (const field of ["revision_id", "outcome", "body", "conditions"]) {
        assert.ok(report.inputSchema.required?.includes(field), `report_outcome no longer requires ${field}`);
      }
      assert.equal(report.inputSchema.properties.body.minLength, 40);
      for (const name of ["search", "get_revision"]) assert.equal(tools.find((x) => x.name === name).annotations?.readOnlyHint, true);
      assert.equal(tools.find((x) => x.name === "create_record").inputSchema.properties.kind.enum.length, 6);
    });

    test("lists the six tools and answers a search entirely in-process", async () => {
      forbidOutbound();
      const client = await connect(base);
      const tools = (await client.listTools()).tools.map((x: any) => x.name).sort();
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

// Requests the SDK rejects before any server exists never reach Sentry's MCP
// integration; they go to the route's reporter. A client on a NEWER protocol
// revision must be reported (as a warning: that is the endpoint falling
// behind); a client's malformed request must not be.
describe("hosted MCP endpoint, rejected requests", () => {
  const reports: { message: string; level: string }[] = [];
  let t: ReturnType<typeof setup>;
  let base: string;
  before(async () => {
    t = setup({ mcpReport: (error, level) => reports.push({ message: error.message, level }) });
    base = await t.app.listen({ host: "127.0.0.1", port: 0 });
  });
  after(() => t.close());
  afterEach(() => { reports.length = 0; });

  test("a client on a future protocol revision is reported as a warning", async () => {
    // A real 2026-07-28 client, rewritten in flight to claim a revision we do not speak.
    const future: typeof fetch = (input, init = {}) => {
      const headers = new Headers(init.headers);
      if (headers.has("mcp-protocol-version")) headers.set("mcp-protocol-version", "2099-01-01");
      const body = typeof init.body === "string" ? init.body.replaceAll('"2026-07-28"', '"2099-01-01"') : init.body;
      return realFetch(input, { ...init, headers, body });
    };
    const client = new ModernClient({ name: "test", version: "0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await assert.rejects(client.connect(new ModernTransport(new URL(`${base}/mcp`), { fetch: future })), /Unsupported protocol version/);
    assert.ok(reports.length > 0, "the rejection was not reported");
    for (const r of reports) {
      assert.equal(r.level, "warning");
      assert.match(r.message, /Unsupported protocol version: 2099-01-01/);
    }
  });

  test("a malformed request is answered but not reported", async () => {
    const res = await realFetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /envelope/);
    assert.deepEqual(reports, []);
  });
});
