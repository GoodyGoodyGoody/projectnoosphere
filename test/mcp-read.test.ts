import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client as ModernClient, StreamableHTTPClientTransport as ModernTransport } from "@modelcontextprotocol/client";
import { createRecordAs, publish, sampleRecord, setup } from "./helpers.ts";

// The hosted read-only endpoint (/mcp/read, src/mcp-http.ts): the same server
// as /mcp with only search and get_revision, and no authentication, for
// clients that can only send a URL (OpenAI's plugin directory). Driven by real
// MCP clients in BOTH protocol eras, like test/mcp-http.test.ts.
const realFetch = globalThis.fetch;
const ERAS = ["2025 era (v1 client)", "2026-07-28 (v2 client, pinned)"] as const;
const WRITE_TOOLS = ["report_outcome", "annotate", "create_record", "propose_revision"];
// Lets the server finish its own bookkeeping after a response has gone out.
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

for (const era of ERAS) describe(`read-only MCP endpoint, ${era}`, () => {
  const modern = era.startsWith("2026");
  let t: ReturnType<typeof setup>;
  let base: string;
  let published: string;
  let outbound: string[];
  before(async () => {
    t = setup({ trustProxy: "127.0.0.1", usage: { flushMs: 0, log: () => {} } });
    base = await t.app.listen({ host: "127.0.0.1", port: 0 });
    published = (await createRecordAs(t.app, t.a.token, sampleRecord({ title: "Quokka read-only endpoint record" }))).revisionId;
    await publish(t.app, t.s.token, published);
  });
  after(() => t.close());
  afterEach(() => { globalThis.fetch = realFetch; });
  // The server must never call out (AGENTS.md): the global fetch fails here.
  const forbidOutbound = () => {
    outbound = [];
    globalThis.fetch = (async (input: unknown) => {
      outbound.push(String(input instanceof Request ? input.url : input));
      throw new Error("outbound request from the server");
    }) as typeof fetch;
  };

  const connect = async (path: string, headers: Record<string, string> = {}, name = "test"): Promise<any> => {
    const url = new URL(`${base}${path}`);
    if (modern) {
      const client = new ModernClient({ name, version: "1.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
      await client.connect(new ModernTransport(url, { fetch: realFetch, requestInit: { headers } }));
      assert.equal(client.getProtocolEra(), "modern");
      return client;
    }
    const client = new LegacyClient({ name, version: "1.0" });
    await client.connect(new LegacyTransport(url, { fetch: realFetch, requestInit: { headers } }));
    return client;
  };
  const textOf = (r: any) => (r.content as { text: string }[]).map((c) => c.text).join("\n");

  test("initialize + tools/list gives exactly search and get_revision, with the same schemas as /mcp", async () => {
    const read = (await (await connect("/mcp/read")).listTools()).tools as any[];
    assert.deepEqual(read.map((x) => x.name).sort(), ["get_revision", "search"]);
    const full = (await (await connect("/mcp")).listTools()).tools as any[];
    for (const tool of read) {
      assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} lost readOnlyHint`);
      assert.deepEqual(tool, full.find((x) => x.name === tool.name), `${tool.name} differs from /mcp's`);
    }
  });

  test("/mcp still lists all six tools", async () => {
    const tools = (await (await connect("/mcp")).listTools()).tools.map((x: any) => x.name).sort();
    assert.deepEqual(tools, ["annotate", "create_record", "get_revision", "propose_revision", "report_outcome", "search"]);
  });

  test("search and get_revision work, entirely in-process", async () => {
    forbidOutbound();
    const client = await connect("/mcp/read");
    const found = textOf(await client.callTool({ name: "search", arguments: { query: "quokka" } }));
    assert.match(found, /^Contributed content from Project Noosphere/);
    assert.ok(found.includes(published));
    const rev = await client.callTool({ name: "get_revision", arguments: { revision_id: published } });
    assert.equal(rev.isError, undefined, textOf(rev));
    assert.match(textOf(rev), /untrusted data/);
    assert.deepEqual(outbound, [], "the server made an outbound request");
  });

  test("every write tool is an unknown tool there, even with a valid key, and nothing is written", async () => {
    const annotations = () => (t.db.prepare("SELECT count(*) FROM annotations").pluck().get() as number);
    const records = () => (t.db.prepare("SELECT count(*) FROM records").pluck().get() as number);
    const before = { annotations: annotations(), records: records() };
    const client = await connect("/mcp/read", { authorization: `Bearer ${t.b.token}` });
    const args: Record<string, unknown> = {
      report_outcome: { revision_id: published, outcome: "worked", body: "Followed it through the read-only endpoint, it worked.", conditions: { os: "Ubuntu 24.04" }, check: { ran: "curl -s localhost/health", observed: "HTTP 200 {\"ok\":true}" } },
      annotate: { revision_id: published, kind: "question", body: "Does this apply on arm64 as well?" },
      create_record: { kind: "observation", title: "Written through the read-only endpoint", summary: "s", body_markdown: "b" },
      propose_revision: { record_id: "rec_01ARZ3NDEKTSV4RRFFQ69G5FAV", base_revision_id: published, kind: "observation", title: "Proposed through read", summary: "s", body_markdown: "b" },
    };
    for (const name of WRITE_TOOLS) {
      // The SDK's normal answer: a JSON-RPC error (or, on some client
      // versions, an error result) saying the tool does not exist.
      let message = "";
      try {
        const r = await client.callTool({ name, arguments: args[name] });
        assert.equal(r.isError, true, `${name} answered without an error: ${textOf(r)}`);
        message = textOf(r);
      } catch (err) {
        message = (err as Error).message;
      }
      assert.match(message, new RegExp(`Tool ${name} not found`), `${name}: ${message}`);
    }
    assert.deepEqual({ annotations: annotations(), records: records() }, before, "a write went through /mcp/read");
  });

  test("its calls are counted as their own channel, mcp-read", async () => {
    t.app.usage.flush();
    t.db.exec("DELETE FROM usage_counts; DELETE FROM usage_searches");
    const client = await connect("/mcp/read", { "user-agent": "ReadTestAgent/1.0", "x-forwarded-for": "198.51.100.41" }, "chatgpt");
    await client.callTool({ name: "search", arguments: { query: "quokka" } });
    await client.close();
    await settle();
    t.app.usage.flush();
    const n = (where: string) => t.db.prepare(`SELECT COALESCE(SUM(count), 0) FROM usage_counts WHERE ${where}`).pluck().get() as number;
    assert.equal(n("tool = 'search' AND channel = 'mcp-read' AND client = 'chatgpt/1'"), 1);
    assert.ok(n("tool = 'connect' AND channel = 'mcp-read'") >= 1, "the handshake was not counted under mcp-read");
    assert.equal(n("channel = 'mcp'"), 0, "a /mcp/read call was counted as /mcp");
    assert.deepEqual(
      t.db.prepare("SELECT query, channel FROM usage_searches").all(),
      [{ query: "quokka", channel: "mcp-read" }],
    );
  });

  test("GET and DELETE are 405 with Allow: POST", async () => {
    for (const method of ["GET", "DELETE"] as const) {
      const res = await t.app.inject({ method, url: "/mcp/read" });
      assert.equal(res.statusCode, 405);
      assert.equal(res.headers.allow, "POST");
    }
  });
});

describe("read-only MCP endpoint, rejected requests", () => {
  const reports: { message: string; level: string }[] = [];
  let t: ReturnType<typeof setup>;
  let base: string;
  before(async () => {
    t = setup({ mcpReport: (error, level) => reports.push({ message: error.message, level }) });
    base = await t.app.listen({ host: "127.0.0.1", port: 0 });
  });
  after(() => t.close());

  test("a client on a future protocol revision is reported as a warning, as on /mcp", async () => {
    const future: typeof fetch = (input, init = {}) => {
      const headers = new Headers(init.headers);
      if (headers.has("mcp-protocol-version")) headers.set("mcp-protocol-version", "2099-01-01");
      const body = typeof init.body === "string" ? init.body.replaceAll('"2026-07-28"', '"2099-01-01"') : init.body;
      return realFetch(input, { ...init, headers, body });
    };
    const client = new ModernClient({ name: "test", version: "0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await assert.rejects(client.connect(new ModernTransport(new URL(`${base}/mcp/read`), { fetch: future })), /Unsupported protocol version/);
    assert.ok(reports.length > 0, "the rejection was not reported");
    for (const r of reports) assert.equal(r.level, "warning");
  });
});

describe("usage_counts after migration 008", () => {
  let t: ReturnType<typeof setup>;
  before(() => { t = setup(); });
  after(() => t.close());

  test("accepts mcp-read and still refuses an unknown channel", () => {
    const add = t.db.prepare("INSERT INTO usage_counts (day, tool, channel, client, status_class, count) VALUES ('2026-10-27', 'search', ?, 'x', '2xx', 1)");
    add.run("mcp-read");
    assert.throws(() => add.run("elsewhere"), /CHECK constraint failed/);
  });
});
