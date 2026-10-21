import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createRecordAs, publish, sampleRecord, setup } from "./helpers.ts";

// The Claude Code plugin (plugins/noosphere): its MCP server entry, with the
// header exactly as the plugin writes it, driven against a real listening app.
// Only the origin is swapped for the local one. The token option is optional:
// left empty (or left unresolved by the client) the plugin must still read;
// with a contributor's own token it must write as that contributor.
const plugin = JSON.parse(readFileSync(new URL("../plugins/noosphere/.claude-plugin/plugin.json", import.meta.url), "utf8"));
const server = plugin.mcpServers.noosphere;
const TEMPLATE = "${user_config.noosphere_token}";

describe("Claude Code plugin", () => {
  let t: ReturnType<typeof setup>;
  let base: string;
  let published: string;
  before(async () => {
    t = setup();
    base = await t.app.listen({ host: "127.0.0.1", port: 0 });
    published = (await createRecordAs(t.app, t.a.token, sampleRecord({ title: "Wombat plugin record" }))).revisionId;
    await publish(t.app, t.s.token, published);
  });
  after(() => t.close());

  const connect = async (token: string) => {
    const url = new URL(new URL(server.url).pathname, base);
    const headers = Object.fromEntries(Object.entries(server.headers as Record<string, string>).map(([k, v]) => [k, v.replace(TEMPLATE, token)]));
    const client = new Client({ name: "plugin-test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
    return client;
  };
  const textOf = (r: any) => (r.content as { text: string }[]).map((c) => c.text).join("\n");
  const report = (revision_id: string) => ({
    name: "report_outcome",
    arguments: { revision_id, outcome: "worked", body: "Followed it through the plugin's MCP entry and it worked as written.", conditions: { os: "Ubuntu 24.04" }, check: { ran: "wombat --version", observed: "wombat 1.2.3" } },
  });

  test("points at the public endpoint over HTTP, and ships no token", () => {
    assert.equal(server.type, "http");
    assert.equal(server.url, "https://projectnoosphere.org/mcp");
    assert.equal(server.headers.Authorization, `Bearer ${TEMPLATE}`);
    const opt = plugin.userConfig.noosphere_token;
    assert.equal(opt.sensitive, true);
    assert.equal(opt.required, false);
    assert.ok(!("default" in opt), "the plugin must never ship a default token");
  });

  for (const [label, token] of [["an empty token", ""], ["an unresolved option", TEMPLATE]] as const) {
    test(`with ${label}: lists the six tools, searches, and refuses writes`, async () => {
      const client = await connect(token);
      const tools = (await client.listTools()).tools.map((x: any) => x.name).sort();
      assert.deepEqual(tools, ["annotate", "create_record", "get_revision", "propose_revision", "report_outcome", "search"]);
      const out = textOf(await client.callTool({ name: "search", arguments: { query: "wombat" } }));
      assert.ok(out.includes(published), out);
      const w = await client.callTool(report(published));
      assert.equal(w.isError, true);
    });
  }

  test("with the user's own token: writes as that contributor", async () => {
    const client = await connect(t.b.token);
    const w = await client.callTool(report(published));
    assert.notEqual(w.isError, true, textOf(w));
    const anns = await t.app.inject({ method: "GET", url: `/api/v1/revisions/${published}/annotations?include=candidate` });
    const mine = anns.json().items.filter((a: any) => a.kind === "outcome_report");
    assert.equal(mine.length, 1);
    assert.equal(mine[0].author_id, t.b.id);
  });
});
