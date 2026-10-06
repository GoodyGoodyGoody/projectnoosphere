import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client as ModernClient, StreamableHTTPClientTransport as ModernTransport } from "@modelcontextprotocol/client";
import { openDb, type DB } from "../src/db.ts";
import { createContributor } from "../src/modules/contributors.ts";
import { clientLabel, isProbeAgent, normalizeQuery, setOwnAddressesForTest, uaFamily, Usage, WITHHELD } from "../src/usage.ts";
import { formatUsageReport, usageReport } from "../src/usage-report.ts";
import { main as usageCli } from "../scripts/usage.ts";
import { bearer, createRecordAs, publish, sampleRecord, setup } from "./helpers.ts";

// Private usage counts (src/usage.ts, migration 007). The last test of each
// group scans every column of every usage row for the addresses and user
// agents the group used: none may ever reach the database.
const IP = "198.51.100.23";
const IP_PROBE = "198.51.100.77";
const UA = "UsageTestAgent/7.3 (marker-ua-5d1f)";
const UA_CURL = "curl/8.5.0";
const DAY = 86_400_000;

type Row = Record<string, unknown>;
const rows = (db: DB, sql: string, ...args: unknown[]) => db.prepare(sql).all(...args) as Row[];
const countOf = (db: DB, where: Row) => {
  const keys = Object.keys(where);
  const sql = `SELECT COALESCE(SUM(count), 0) FROM usage_counts WHERE ${keys.map((k) => `${k} = ?`).join(" AND ") || "1"}`;
  return db.prepare(sql).pluck().get(...keys.map((k) => where[k])) as number;
};
// Lets the server finish its own bookkeeping after a response has gone out.
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

function assertNothingIdentifying(db: DB, needles: string[]) {
  for (const table of ["usage_counts", "usage_searches", "usage_visitors"]) {
    for (const row of rows(db, `SELECT * FROM ${table}`)) {
      for (const [col, value] of Object.entries(row)) {
        for (const needle of needles) {
          assert.ok(!String(value).toLowerCase().includes(needle.toLowerCase()), `${table}.${col} holds "${needle}": ${String(value)}`);
        }
      }
    }
  }
}

describe("usage counts through the real routes", () => {
  let t: ReturnType<typeof setup>;
  let base: string;
  let house: { token: string; id: string };
  const realFetch = globalThis.fetch;
  const logged: string[] = [];

  before(async () => {
    t = setup({ trustProxy: "127.0.0.1", usage: { flushMs: 0, log: (msg) => logged.push(msg) } });
    base = await t.app.listen({ host: "127.0.0.1", port: 0 });
    const { revisionId } = await createRecordAs(t.app, t.a.token, sampleRecord({ title: "Quokka usage record" }));
    await publish(t.app, t.s.token, revisionId);
    const h = createContributor(t.db, { displayName: "Codex (site operator's agent)" });
    house = { token: h.credential.token, id: h.contributorId };
    await settle();
    t.app.usage.flush();
    // Setup traffic (loopback, steward) is house; start each test from zero.
    t.db.exec("DELETE FROM usage_counts; DELETE FROM usage_searches; DELETE FROM usage_visitors");
  });
  after(() => t.close());

  const fresh = () => {
    t.app.usage.flush();
    t.db.exec("DELETE FROM usage_counts; DELETE FROM usage_searches");
  };

  for (const era of ["2025 era (v1 client)", "2026-07-28 (v2 client)"] as const) {
    test(`hosted MCP, ${era}: initialize as claude-code, then one search, counts one search under claude-code / mcp`, async () => {
      fresh();
      const headers = { "user-agent": UA, "x-forwarded-for": IP };
      const url = new URL(`${base}/mcp`);
      let client: any;
      if (era.startsWith("2026")) {
        client = new ModernClient({ name: "claude-code", version: "2.1.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
        await client.connect(new ModernTransport(url, { fetch: realFetch, requestInit: { headers } }));
      } else {
        // The 2025 handshake names the client only in initialize; the search
        // that follows is a separate, stateless request.
        client = new LegacyClient({ name: "claude-code", version: "2.1.0" });
        await client.connect(new LegacyTransport(url, { fetch: realFetch, requestInit: { headers } }));
      }
      const r = await client.callTool({ name: "search", arguments: { query: "quokka" } });
      assert.match(r.content[0].text, /Quokka usage record/);
      await client.close();
      await settle();
      t.app.usage.flush();

      assert.equal(countOf(t.db, { tool: "search" }), 1, "one tool call, one count");
      assert.equal(countOf(t.db, { tool: "search", channel: "mcp", client: "claude-code/2", status_class: "2xx" }), 1);
      // The handshake is counted too, as outside use once a tool was called.
      assert.ok(countOf(t.db, { tool: "connect", channel: "mcp", client: "claude-code/2" }) >= 1);
      assert.equal(countOf(t.db, { channel: "probe" }), 0);
      assert.deepEqual(rows(t.db, "SELECT query, channel, client, count, result_count, zero_results FROM usage_searches"), [
        { query: "quokka", channel: "mcp", client: "claude-code/2", count: 1, result_count: 1, zero_results: 0 },
      ]);
    });
  }

  test("get_revision makes three API calls but counts as one", async () => {
    fresh();
    const client = new LegacyClient({ name: "cursor", version: "1.4" });
    await client.connect(new LegacyTransport(new URL(`${base}/mcp`), { fetch: realFetch, requestInit: { headers: { "user-agent": UA, "x-forwarded-for": IP } } }));
    const found = await client.callTool({ name: "search", arguments: { query: "quokka" } }) as any;
    const id = (found.content[0].text as string).match(/rev_[0-9A-Z]{26}/)![0];
    await client.callTool({ name: "get_revision", arguments: { revision_id: id } });
    // A write tool with no token never reaches the API; it still counts.
    await client.callTool({ name: "annotate", arguments: { revision_id: id, kind: "question", body: "Does this hold on Node 22?" } });
    await client.close();
    await settle();
    t.app.usage.flush();
    assert.equal(countOf(t.db, { tool: "get_revision", channel: "mcp", client: "cursor/1" }), 1);
    assert.equal(countOf(t.db, { tool: "list" }), 0, "get_revision's follow-up reads were counted");
    assert.equal(countOf(t.db, { tool: "annotate", channel: "mcp", status_class: "4xx" }), 1);
  });

  test("a REST search counts under web, with the user agent's family as the client", async () => {
    fresh();
    const res = await t.app.inject({ url: "/api/v1/search?q=Quokka", remoteAddress: IP, headers: { "user-agent": UA_CURL } });
    assert.equal(res.statusCode, 200);
    // The HTML search page is web use too.
    const page = await t.app.inject({ url: "/search?q=quokka", remoteAddress: IP, headers: { "user-agent": UA } });
    assert.equal(page.statusCode, 200);
    await settle();
    t.app.usage.flush();
    assert.equal(countOf(t.db, { tool: "search", channel: "web", client: "curl/8" }), 1);
    assert.equal(countOf(t.db, { tool: "search", channel: "web", client: "usagetestagent/7" }), 1);
    assert.deepEqual(rows(t.db, "SELECT client, query, count FROM usage_searches ORDER BY client"), [
      { client: "curl/8", query: "quokka", count: 1 },
      { client: "usagetestagent/7", query: "quokka", count: 1 },
    ]);
  });

  test("the operator's own agents and the server itself count under house, never as outside use", async () => {
    fresh();
    // An outside address, but the operator's agent's token: house.
    const a = await t.app.inject({ url: "/api/v1/search?q=quokka", remoteAddress: IP, headers: { "user-agent": UA, ...bearer(house.token) } });
    // A write by the same agent.
    const w = await t.app.inject({ method: "POST", url: "/api/v1/records", remoteAddress: IP, headers: { "user-agent": UA, ...bearer(house.token) }, payload: sampleRecord({ title: "House agent record" }) });
    // The server calling itself (loopback, no proxy in between).
    const b = await t.app.inject({ url: "/api/v1/search?q=quokka", remoteAddress: "127.0.0.1", headers: { "user-agent": UA } });
    // An ordinary contributor from the same address is outside use.
    const c = await t.app.inject({ url: "/api/v1/search?q=quokka", remoteAddress: IP, headers: { "user-agent": UA, ...bearer(t.a.token) } });
    for (const r of [a, b, c]) assert.equal(r.statusCode, 200);
    assert.equal(w.statusCode, 201);
    await settle();
    t.app.usage.flush();
    assert.equal(countOf(t.db, { channel: "house", tool: "search" }), 2);
    assert.equal(countOf(t.db, { channel: "house", tool: "create_record" }), 1);
    assert.equal(countOf(t.db, { channel: "web" }), 1);
    const report = usageReport(t.db, { days: 1 });
    assert.equal(report.by_class[0]!.house, 3);
    assert.equal(report.by_class[0]!.outside, 1);
    assert.equal(report.top_searches[0]!.searches, 1, "house searches leaked into the outside top searches");
  });

  test("a request from one of this machine's own addresses counts as house; a public one stays outside", async () => {
    const own = "203.0.113.9";
    setOwnAddressesForTest([own]);
    fresh();
    const a = await t.app.inject({ url: "/api/v1/search?q=quokka", remoteAddress: own, headers: { "user-agent": "node" } });
    const b = await t.app.inject({ url: "/api/v1/search?q=quokka", remoteAddress: IP, headers: { "user-agent": UA } });
    assert.equal(a.statusCode, 200);
    assert.equal(b.statusCode, 200);
    await settle();
    t.app.usage.flush();
    assert.equal(countOf(t.db, { channel: "house", tool: "search" }), 1);
    assert.equal(countOf(t.db, { channel: "web" }), 1);
    const report = usageReport(t.db, { days: 1 });
    assert.equal(report.by_class[0]!.house, 1);
    assert.equal(report.by_class[0]!.outside, 1);
  });

  test("a probe user agent counts under probe", async () => {
    fresh();
    const res = await t.app.inject({ url: "/api/v1/search?q=quokka", remoteAddress: IP_PROBE, headers: { "user-agent": "mcpbeat/1.0 (+https://mcpbeat.example)" } });
    assert.equal(res.statusCode, 200);
    await settle();
    t.app.usage.flush();
    assert.equal(countOf(t.db, { channel: "probe", tool: "search" }), 1);
    assert.equal(countOf(t.db, { channel: "web" }), 0);
  });

  test("an MCP probe by name counts under probe, handshake and all", async () => {
    fresh();
    const client = new LegacyClient({ name: "MCPWatch", version: "3.1" });
    await client.connect(new LegacyTransport(new URL(`${base}/mcp`), { fetch: realFetch, requestInit: { headers: { "x-forwarded-for": IP_PROBE } } }));
    await client.listTools();
    await client.close();
    await settle();
    t.app.usage.flush();
    assert.ok(countOf(t.db, { channel: "probe", tool: "connect", client: "mcpwatch/3" }) >= 2);
    assert.equal(countOf(t.db, { channel: "mcp" }), 0);
  });

  test("searches that look like secrets or personal data are kept only as [withheld], still counted", async () => {
    fresh();
    const secrets = [
      "error for jane.doe@example.com on login",
      "sk-proj-4f8a9c2e1b7d6a5f3e2c1b0a",
      "stripe rk_live_51HxYzAbCdEfGhIjKl rejected",
      "call +1 (415) 555-0134 about the outage",
    ];
    for (const q of secrets) {
      const res = await t.app.inject({ url: `/api/v1/search?q=${encodeURIComponent(q)}`, remoteAddress: IP, headers: { "user-agent": UA } });
      assert.equal(res.statusCode, 200);
    }
    await settle();
    t.app.usage.flush();
    assert.deepEqual(rows(t.db, "SELECT query, count FROM usage_searches"), [{ query: WITHHELD, count: secrets.length }]);
    assertNothingIdentifying(t.db, ["jane.doe", "example.com", "sk-proj", "rk_live", "4f8a9c2e", "555-0134", "5550134"]);
  });

  test("a search that finds nothing is flagged; one that finds something is not", async () => {
    fresh();
    for (const q of ["  Zebra   Unicycle Repair ", "quokka"]) {
      await t.app.inject({ url: `/api/v1/search?q=${encodeURIComponent(q)}`, remoteAddress: IP, headers: { "user-agent": UA } });
    }
    await settle();
    t.app.usage.flush();
    assert.deepEqual(rows(t.db, "SELECT query, result_count, zero_results FROM usage_searches ORDER BY query"), [
      { query: "quokka", result_count: 1, zero_results: 0 },
      { query: "zebra unicycle repair", result_count: 0, zero_results: 1 },
    ]);
    assert.deepEqual(usageReport(t.db, { days: 1 }).zero_result_searches.map((z) => z.query), ["zebra unicycle repair"]);
  });

  test("an outside caller cannot pass as an in-process MCP call", async () => {
    fresh();
    await t.app.inject({ url: "/api/v1/search?q=quokka", remoteAddress: IP, headers: { "user-agent": UA_CURL, "x-noosphere-usage": "0".repeat(32) } });
    await settle();
    t.app.usage.flush();
    assert.equal(countOf(t.db, { channel: "web", tool: "search" }), 1);
  });

  test("a database error while counting never fails a request, and is logged once", async () => {
    fresh();
    t.db.exec("ALTER TABLE usage_counts RENAME TO usage_counts_away");
    try {
      for (let i = 0; i < 3; i++) {
        const res = await t.app.inject({ url: "/api/v1/search?q=quokka", remoteAddress: IP, headers: { "user-agent": UA } });
        assert.equal(res.statusCode, 200);
        assert.equal(res.json().items.length, 1);
        await settle();
        t.app.usage.flush();
      }
      assert.equal(logged.filter((m) => /usage counting failed/.test(m)).length, 1);
    } finally {
      t.db.exec("ALTER TABLE usage_counts_away RENAME TO usage_counts");
    }
    // Counting recovers once the database does.
    await t.app.inject({ url: "/api/v1/search?q=quokka", remoteAddress: IP, headers: { "user-agent": UA } });
    await settle();
    t.app.usage.flush();
    assert.equal(countOf(t.db, { tool: "search" }), 1);
  });

  test("no address, user agent or contributor id ever reaches the usage tables", async () => {
    t.app.usage.flush();
    assert.ok(Number(t.db.prepare("SELECT count(*) FROM usage_visitors").pluck().get()) > 0, "no visitors recorded at all");
    assertNothingIdentifying(t.db, [
      IP, IP_PROBE, "127.0.0.1", UA, "marker-ua-5d1f", UA_CURL, "curl/8.5.0", "mcpbeat.example",
      t.a.id, t.b.id, t.s.id, house.id, house.token, t.a.token,
    ]);
  });
});

describe("usage rules", () => {
  test("probe rule: today's checkers are probes, by rule rather than by name", () => {
    // The checkers seen in the logs to 2026-10-06, written the way such tools
    // name themselves (a probe word, or a +http contact URL). Checkers whose
    // user agent says neither are caught by behaviour (next test).
    const checkers = [
      "mcpbeat/1.0 (+https://mcpbeat.example)",
      "rokmcp-checker/0.3",
      "BrickBlue-Monitor/2.0",
      "Mozilla/5.0 (compatible; GolemreachBot/1.1; +https://golemreach.example/bot)",
      "mcp.market crawler (+https://mcp.market)",
      "ProofBench-Probe/0.9",
      "agentprobe/1.2",
      "protogrid-scanner/1.0",
      "MCPWatch/3.1",
    ];
    for (const ua of checkers) assert.equal(isProbeAgent(ua), true, ua);
    const people = [
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      "claude-code/2.0.14",
      "python-httpx/0.28.1",
      "node",
      // Fetched because a person asked: outside use, despite the contact URL.
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
    ];
    for (const ua of people) assert.equal(isProbeAgent(ua), false, ua);
  });

  test("probe rule: an MCP caller that only ever connects becomes a probe when it goes quiet", async () => {
    let now = Date.parse("2026-10-06T12:00:00Z");
    const t = setup({ trustProxy: "127.0.0.1", usage: { flushMs: 0, now: () => now } });
    try {
      const base = await t.app.listen({ host: "127.0.0.1", port: 0 });
      const headers = { "user-agent": "SomeTool/1.0", "x-forwarded-for": IP };
      const client = new LegacyClient({ name: "golemreach", version: "1" });
      await client.connect(new LegacyTransport(new URL(`${base}/mcp`), { fetch: globalThis.fetch, requestInit: { headers } }));
      await client.listTools();
      await client.close();
      await settle();
      t.app.usage.flush();
      assert.equal(countOf(t.db, {}), 0, "held until the caller either calls a tool or goes quiet");
      now += 31 * 60 * 1000;
      t.app.usage.flush();
      assert.ok(countOf(t.db, { channel: "probe", tool: "connect", client: "golemreach/1" }) >= 2);
      assert.equal(countOf(t.db, { channel: "mcp" }), 0);
      assert.deepEqual(rows(t.db, "SELECT class FROM usage_visitors"), [{ class: "probe" }]);
      assertNothingIdentifying(t.db, [IP, "SomeTool/1.0"]);
    } finally {
      await t.close();
    }
  });

  test("client labels are short, safe, and 'other' when unrecognisable", () => {
    assert.equal(clientLabel("claude-code", "2.1.0"), "claude-code/2");
    assert.equal(clientLabel("Claude Desktop", "v0.9"), "claude-desktop/0");
    assert.equal(clientLabel("x".repeat(41)), "other");
    assert.equal(clientLabel("me@example.com"), "other");
    assert.equal(clientLabel("host-198.51.100.23"), "other");
    assert.equal(clientLabel("<script>"), "other");
    assert.equal(clientLabel(""), "other");
    assert.equal(uaFamily("curl/8.5.0").label, "curl/8");
    assert.equal(uaFamily("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/141.0 Safari/537.36 Edg/141.0").label, "edge/141");
    assert.equal(uaFamily("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)").label, "googlebot/2");
    assert.equal(uaFamily("198.51.100.23").label, "other");
    assert.equal(uaFamily(undefined).label, "other");
    for (const s of ["claude-code/2", "curl/8", "other"]) assert.ok(s.length <= 40);
  });

  test("query normalization", () => {
    assert.equal(normalizeQuery("  PM2   Reload\n502 "), "pm2 reload 502");
    assert.equal(normalizeQuery("word ".repeat(60)).length, 200);
    for (const q of [
      "me@example.org", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "xoxb-1234-5678", "AKIAIOSFODNN7EXAMPLE",
      "-----BEGIN OPENSSH PRIVATE KEY-----", "deadbeefdeadbeefdeadbeefdeadbeef", "pk_test_abc", "nsp_abcdefghijkl_x",
      "token aGVsbG8gd29ybGQgdGhpcyBpcyBhIGtleQ1234XYZ",
    ]) assert.equal(normalizeQuery(q), WITHHELD, q);
    for (const q of ["task-runner exits 1", "node 24.19.0 sqlite", "rev_01J9ZK3M8Q4R5S6T7V8W9X0Y1Z", "ERR_REQUIRE_ESM in jest"]) {
      assert.notEqual(normalizeQuery(q), WITHHELD, q);
    }
  });
});

describe("usage storage: caps, retention, monthly key", () => {
  let dir: ReturnType<typeof setup>;
  let db: DB;
  before(() => {
    dir = setup();
    db = dir.db;
  });
  after(() => dir.close());

  test("past the per-day key cap, the rest count under 'other', and nothing is lost", () => {
    db.exec("DELETE FROM usage_counts");
    const u = new Usage(db, { keyCap: 3, log: () => {} });
    for (let i = 0; i < 10; i++) u.count("search", "web", `client${String.fromCharCode(97 + i)}`, 200);
    u.count("search", "web", "clienta", 200);
    u.flush();
    const clients = rows(db, "SELECT client, count FROM usage_counts ORDER BY client");
    assert.deepEqual(clients, [
      { client: "clienta", count: 2 }, { client: "clientb", count: 1 }, { client: "clientc", count: 1 }, { client: "other", count: 7 },
    ]);
  });

  test("search rows older than 30 days are deleted; recent ones stay", () => {
    db.exec("DELETE FROM usage_searches");
    const today = Date.parse("2026-10-06T12:00:00Z");
    let now = today;
    const u = new Usage(db, { now: () => now, log: () => {} });
    // Each search is written on its own day, as the clock moves forward.
    for (const ago of [45, 31, 30, 29, 0]) {
      now = today - ago * DAY;
      u.search("web", "curl/8", `searched ${ago} days ago`, 1);
      u.flush();
    }
    assert.deepEqual(rows(db, "SELECT day FROM usage_searches ORDER BY day").map((r) => r.day), ["2026-09-07", "2026-10-06"],
      "rows from 30 or more days ago survived today's write");
    // Two days later, the next write deletes what has aged out since.
    now = today + 2 * DAY;
    u.flush();
    assert.deepEqual(rows(db, "SELECT day FROM usage_searches ORDER BY day").map((r) => r.day), ["2026-10-06"]);
  });

  test("the visitor hash changes with the month's key, and the old month's hashes are deleted", () => {
    db.exec("DELETE FROM usage_visitors");
    let now = Date.parse("2026-10-30T12:00:00Z");
    const u = new Usage(db, { now: () => now, log: () => {} });
    const key = () => db.prepare("SELECT value FROM settings WHERE key = 'usage_visitor_key'").pluck().get() as string;
    u.visit("outside", u.visitorHash(IP, "curl"));
    now += DAY;
    u.visit("outside", u.visitorHash(IP, "curl"));
    u.flush();
    const october = rows(db, "SELECT month, hash, first_day, days_mask FROM usage_visitors");
    assert.equal(october.length, 1);
    assert.equal(october[0]!.month, "2026-10");
    assert.equal(october[0]!.first_day, "2026-10-30");
    assert.equal(october[0]!.days_mask, (1 << 29) | (1 << 30), "seen on the 30th and the 31st");
    assert.equal(usageReport(db, { days: 2, now }).visitors.returning.outside, 1);
    const octKey = key();
    assert.match(octKey, /^2026-10:[0-9a-f]{64}$/);

    now = Date.parse("2026-11-01T09:00:00Z");
    u.visit("outside", u.visitorHash(IP, "curl"));
    u.flush();
    const november = rows(db, "SELECT month, hash FROM usage_visitors");
    assert.equal(november.length, 1, "October's hashes are still there");
    assert.equal(november[0]!.month, "2026-11");
    assert.notEqual(november[0]!.hash, october[0]!.hash, "same visitor, same hash across months");
    assert.match(key(), /^2026-11:[0-9a-f]{64}$/);
    assert.ok(!key().includes(octKey.slice(8)), "October's key was kept");
    assertNothingIdentifying(db, [IP]);
  });
});

describe("npm run usage", () => {
  let t: ReturnType<typeof setup>;
  before(() => { t = setup({ usage: { flushMs: 0 } }); });
  after(() => t.close());

  const SECTIONS = [
    "Outside calls per day, by tool", "Outside calls by client", "Probes vs outside vs house",
    "Top searches", "Searches that found nothing", "Visitors",
  ];

  test("on an empty database every section says 'nothing yet', with no zeros presented as findings", () => {
    const { code, out } = usageCli(["--days", "7"], join(t.dir, "test.sqlite"));
    assert.equal(code, 0, out);
    for (const s of SECTIONS) assert.match(out, new RegExp(`${s}[^\\n]*\\n  nothing yet\\n`), s);
    assert.doesNotMatch(out, /\b0 (calls|searches|visitors)\b/);
  });

  test("with traffic it prints every section, and --json carries the same", async () => {
    await t.app.inject({ url: "/api/v1/search?q=nothing+matches+this", remoteAddress: IP, headers: { "user-agent": UA_CURL } });
    await t.app.inject({ url: "/api/v1/search?q=quokka", remoteAddress: IP, headers: { "user-agent": "agentprobe/1.2" } });
    await t.app.inject({ url: "/api/v1/records", headers: { "user-agent": UA_CURL } });
    await settle();
    t.app.usage.flush();
    const { code, out } = usageCli([], join(t.dir, "test.sqlite"));
    assert.equal(code, 0, out);
    for (const s of SECTIONS) assert.match(out, new RegExp(s), s);
    assert.match(out, /"nothing matches this"/);
    assert.match(out, /curl\/8 \(web\)/);
    const json = JSON.parse(usageCli(["--json", "--days", "3"], join(t.dir, "test.sqlite")).out);
    assert.equal(json.days.length, 3);
    assert.deepEqual(json.zero_result_searches.map((z: any) => z.query), ["nothing matches this"]);
    assert.equal(json.by_class.at(-1).probe, 1);
    assert.equal(json.by_class.at(-1).house, 1);
    assert.equal(json.visitors.by_day.at(-1).outside, 1);
    assert.equal(formatUsageReport(usageReport(t.db)), usageCli([], join(t.dir, "test.sqlite")).out);
  });

  test("the public terms page says what is kept, beside the unchanged contribution terms", async () => {
    const res = await t.app.inject({ url: "/terms" });
    assert.equal(res.statusCode, 200);
    const body = res.body;
    assert.match(body, /What Noosphere keeps about requests/);
    for (const point of [/Daily counts/, /Search text, for 30 days/, /\[withheld\]/, /key that changes every month/, /access logs/i]) {
      assert.match(body, point);
    }
    assert.ok(body.indexOf("noosphere-terms/1") < body.indexOf("What Noosphere keeps about requests"));
  });

  test("refuses bad arguments and a database without the usage tables", () => {
    assert.equal(usageCli(["--days", "0"], join(t.dir, "test.sqlite")).code, 2);
    assert.equal(usageCli(["--bogus"], join(t.dir, "test.sqlite")).code, 2);
    const bare = join(t.dir, "bare.sqlite");
    openDb(bare).close();
    assert.match(usageCli([], bare).out, /migration 007/);
  });
});

describe("usage measures use, not traffic", () => {
  let t: ReturnType<typeof setup>;
  const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  const CHATGPT = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";
  const WP = "http://projectnoosphere.org/wp-admin/install.php?step=1";
  before(() => { t = setup({ trustProxy: "127.0.0.1", usage: { flushMs: 0 } }); });
  after(() => t.close());
  const get = async (url: string, ip: string, ua: string) => {
    await t.app.inject({ url, remoteAddress: ip, headers: { "user-agent": ua, "x-forwarded-for": ip } });
    await settle();
  };
  const reset = () => { t.app.usage.flush(); t.db.exec("DELETE FROM usage_counts; DELETE FROM usage_searches; DELETE FROM usage_visitors"); };

  test("health checks are not counted at all, and make no visitor", async () => {
    reset();
    await get("/readyz", "198.51.100.5", "curl/8.6.0");
    await get("/healthz", "198.51.100.5", "curl/8.6.0");
    t.app.usage.flush();
    assert.equal(countOf(t.db, {}), 0);
    assert.equal(rows(t.db, "SELECT * FROM usage_visitors").length, 0);
  });

  test("a page-only caller is one separate number, not a returning user", async () => {
    reset();
    await get("/", "198.51.100.6", "curl/8.6.0");
    await get("/", "198.51.100.6", "curl/8.6.0");
    await get("/api/v1/search?q=quokka", "198.51.100.7", CHROME);
    t.app.usage.flush();
    assert.deepEqual(rows(t.db, "SELECT class FROM usage_visitors ORDER BY class"), [{ class: "outside" }, { class: "page" }]);
    const v = usageReport(t.db, { days: 1 }).visitors;
    assert.equal(v.page_only, 1);
    assert.equal(v.by_day[0]!.outside, 1);
  });

  test("scanners are probes: URL, '-' or empty user agent, and well-known scanner paths", async () => {
    reset();
    await get("/api/v1/search?q=quokka", "198.51.100.8", WP);
    await get("/api/v1/search?q=quokka", "198.51.100.9", "-");
    await get("/api/v1/search?q=quokka", "198.51.100.10", "");
    // A browser-looking caller that asks for a scanner path is a probe for the day.
    await get("/wp-login.php", "198.51.100.11", CHROME);
    await get("/api/v1/search?q=quokka", "198.51.100.11", CHROME);
    // A person's fetch and a plain browser stay outside.
    await get("/api/v1/search?q=quokka", "198.51.100.12", CHATGPT);
    await get("/api/v1/search?q=quokka", "198.51.100.13", CHROME);
    t.app.usage.flush();
    assert.equal(countOf(t.db, { channel: "web", tool: "search" }), 2);
    assert.equal(countOf(t.db, { channel: "probe", tool: "search" }), 4);
    assert.equal(countOf(t.db, { channel: "probe", tool: "other" }), 1);
    assert.equal(rows(t.db, "SELECT * FROM usage_visitors WHERE class = 'outside'").length, 2);
    assertNothingIdentifying(t.db, ["198.51.100", "wp-admin", "AppleWebKit"]);
  });

  test("a credential written as name=value is withheld", () => {
    assert.equal(normalizeQuery("password=hunter2 not working"), WITHHELD);
    assert.equal(normalizeQuery("api_key: abc123"), WITHHELD);
    assert.equal(normalizeQuery("Authorization: x"), WITHHELD);
    assert.notEqual(normalizeQuery("how to reset a password in sqlite"), WITHHELD);
  });
});
