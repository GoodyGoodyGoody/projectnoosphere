import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { NoosphereClient } from "../src/librarian/client.ts";
import { scriptedReviewer } from "../src/librarian/fake.ts";
import { changedUrls, submitIndexNow, type IndexNowConfig } from "../src/librarian/indexnow.ts";
import { runCycle } from "../src/librarian/run.ts";
import { SpendLedger } from "../src/librarian/spend.ts";
import { bearer, createRecordAs, sampleRecord, setup, TEST_ORIGIN } from "./helpers.ts";

// IndexNow (migration 005): the server serves the key file and tells stewards
// the settings; the librarian pings. The server itself never calls out.
describe("IndexNow", () => {
  let t: ReturnType<typeof setup>;
  let base: string;
  let key: string;
  before(async () => {
    t = setup();
    base = await t.app.listen({ host: "127.0.0.1", port: 0 });
    key = t.db.prepare("SELECT value FROM settings WHERE key = 'indexnow_key'").pluck().get() as string;
  });
  after(() => t.close());

  test("the migration generated a protocol-valid key", () => {
    assert.match(key, /^[0-9a-f]{32}$/);
  });

  test("the key file is served at the root, as plain text, and not indexed", async () => {
    const res = await t.app.inject({ url: `/${key}.txt` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, key);
    assert.match(String(res.headers["content-type"]), /^text\/plain/);
    assert.equal(res.headers["x-robots-tag"], "noindex");
    assert.equal((await t.app.inject({ url: `/${"0".repeat(32)}.txt` })).statusCode, 404);
  });

  test("the key is never published: not in OpenAPI (which documents only the steward route), the sitemap, robots.txt, or llms.txt", async () => {
    for (const url of ["/openapi.json", "/sitemap.xml", "/robots.txt", "/llms.txt"]) {
      const body = (await t.app.inject({ url })).body;
      assert.ok(!body.includes(key), `${url} leaks the key`);
      if (url !== "/openapi.json") assert.ok(!body.includes("/api/v1/admin/indexnow"), `${url} lists the admin route`);
    }
  });

  test("the settings endpoint is steward-only and derives everything from the public origin", async () => {
    assert.equal((await t.app.inject({ url: "/api/v1/admin/indexnow" })).statusCode, 401);
    assert.equal((await t.app.inject({ url: "/api/v1/admin/indexnow", headers: bearer(t.a.token) })).statusCode, 403);
    const res = await t.app.inject({ url: "/api/v1/admin/indexnow", headers: bearer(t.s.token) });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      host: new URL(TEST_ORIGIN).host, key, key_location: `${TEST_ORIGIN}/${key}.txt`, origin: TEST_ORIGIN,
    });
  });

  test("changed URLs: the record page of what was published, plus the home page — nothing else", async () => {
    const pub = (await createRecordAs(t.app, t.a.token, sampleRecord({ title: "IndexNow MARK-PUB" }))).revisionId;
    const held = (await createRecordAs(t.app, t.a.token, sampleRecord({ title: "IndexNow held" }))).revisionId;
    const decide = (i: { user: string }) => (i.user.includes("MARK-PUB") ? "publish" as const : "hold" as const);
    const dir = mkdtempSync(join(t.dir, "inx-"));
    const applied: { action: string; revisionId: string }[] = [];
    const client = new NoosphereClient(base, t.s.token);
    await runCycle({
      client, primary: scriptedReviewer("a", decide), second: scriptedReviewer("b", decide),
      rubricVersion: "inx", ledger: new SpendLedger(join(dir, "s.jsonl")), monthlyCapUsd: 50, runCapUsd: 5,
      pauseFile: join(dir, "p"), notify: () => {}, canaries: [],
      onApplied: (action, _t, revisionId) => applied.push({ action, revisionId }),
    });
    assert.deepEqual(applied.map((a) => a.action).sort(), ["hold_revision", "publish_revision"]);
    assert.ok(applied.some((a) => a.revisionId === held));
    const cfg = (await client.indexnow())!;
    const urls = await changedUrls(client, applied, cfg.origin);
    const slug = (await client.revision(pub)).record_slug;
    assert.deepEqual(urls, [`${TEST_ORIGIN}/r/${slug}`, `${TEST_ORIGIN}/`]);
    assert.deepEqual(await changedUrls(client, applied.filter((a) => a.action === "hold_revision"), cfg.origin), []);
    // Each guard alone: a non-public action on a PUBLISHED revision pings nothing,
    // and a "publish" of a revision that is not current (still a candidate here,
    // with only a provisional address) pings nothing either.
    assert.deepEqual(await changedUrls(client, [{ action: "hold_revision", revisionId: pub }], cfg.origin), []);
    assert.deepEqual(await changedUrls(client, [{ action: "publish_revision", revisionId: held }], cfg.origin), []);
  });
});

describe("submitIndexNow", () => {
  const cfg: IndexNowConfig = {
    host: "example.org", key: "k".repeat(32), key_location: `https://example.org/${"k".repeat(32)}.txt`, origin: "https://example.org",
  };
  // A fake network: records every call; the key file answers with `served`.
  const net = (opts: { served?: string; keyStatus?: number; pingStatus?: number; pingThrows?: boolean } = {}) => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === cfg.key_location) return new Response(opts.served ?? cfg.key, { status: opts.keyStatus ?? 200 });
      if (opts.pingThrows) throw new Error("ECONNRESET");
      return new Response(opts.pingStatus === 403 ? "UserForbiddedToAccessSite" : "", { status: opts.pingStatus ?? 202 });
    }) as unknown as typeof globalThis.fetch;
    return { calls, fetch };
  };
  const urls = ["https://example.org/r/a", "https://example.org/"];

  test("sends one protocol-shaped POST after verifying the key file", async () => {
    const n = net();
    const r = await submitIndexNow(cfg, urls, { fetch: n.fetch, endpoint: "https://ping.test/indexnow" });
    assert.deepEqual(r, { submitted: 2, status: 202 });
    assert.deepEqual(n.calls.map((c) => c.url), [cfg.key_location, "https://ping.test/indexnow"]);
    assert.deepEqual(JSON.parse(String(n.calls[1]!.init!.body)), { host: "example.org", key: cfg.key, keyLocation: cfg.key_location, urlList: urls });
  });

  test("a key file that does not serve the key stops the ping (no POST)", async () => {
    const n = net({ served: "some-other-key" });
    const r = await submitIndexNow(cfg, urls, { fetch: n.fetch });
    assert.equal(r.submitted, 0);
    assert.match(r.skipped!, /does not serve this key/);
    assert.equal(n.calls.length, 1);
  });

  test("loopback hosts and empty lists never touch the network", async () => {
    const n = net();
    assert.match((await submitIndexNow({ ...cfg, host: "127.0.0.1:4400" }, urls, { fetch: n.fetch })).skipped!, /not a public host/);
    assert.match((await submitIndexNow(cfg, [], { fetch: n.fetch })).skipped!, /nothing changed/);
    assert.equal(n.calls.length, 0);
  });

  test("URLs outside the host are refused", async () => {
    const n = net();
    const r = await submitIndexNow(cfg, ["https://elsewhere.test/x"], { fetch: n.fetch });
    assert.match(r.error!, /outside example.org/);
    assert.equal(n.calls.length, 0);
  });

  test("a rejected or failed ping is reported as an error, never thrown", async () => {
    const forbidden = await submitIndexNow(cfg, urls, { fetch: net({ pingStatus: 403 }).fetch });
    assert.equal(forbidden.status, 403);
    assert.match(forbidden.error!, /^HTTP 403/);
    const thrown = await submitIndexNow(cfg, urls, { fetch: net({ pingThrows: true }).fetch });
    assert.match(thrown.error!, /ping threw/);
  });
});
