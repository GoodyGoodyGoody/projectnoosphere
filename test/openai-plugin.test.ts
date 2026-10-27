import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { crc32, inflateRawSync } from "node:zlib";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { buildPackage, PLUGIN_DIR, READ_ENDPOINT } from "../scripts/package-openai-plugin.ts";
import { createRecordAs, publish, sampleRecord, setup } from "./helpers.ts";

// The OpenAI plugin package (plugins/noosphere-openai) and the script that
// zips it (scripts/package-openai-plugin.ts). The ZIP is read back with an
// independent reader (central directory, then each entry), so a broken writer
// cannot pass by agreeing with itself.
function unzip(buf: Buffer): Map<string, Buffer> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "no end-of-central-directory record");
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, "bad central directory entry");
    const method = buf.readUInt16LE(p + 10);
    const packedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    assert.equal(buf.readUInt32LE(local), 0x04034b50, `bad local header for ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const packed = buf.subarray(start, start + packedSize);
    const data = method === 8 ? inflateRawSync(packed) : packed;
    assert.equal(data.length, size, `${name} has the wrong size`);
    assert.equal(crc32(data), buf.readUInt32LE(p + 16), `${name} has the wrong CRC`);
    out.set(name, data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe("OpenAI plugin package", () => {
  let scratch: string;
  before(() => { scratch = mkdtempSync(join(tmpdir(), "noosphere-openai-")); });
  after(() => rmSync(scratch, { recursive: true, force: true }));

  test("the script builds a ZIP whose manifest parses and names /mcp/read, with no auth", () => {
    const out = join(scratch, "dist", "noosphere-openai-plugin.zip");
    execFileSync(process.execPath, [join(import.meta.dirname, "..", "scripts", "package-openai-plugin.ts"), "--out", out], { stdio: "pipe" });
    const files = unzip(readFileSync(out));
    for (const f of ["plugin.json", "mcp.json", "skills/noosphere/SKILL.md", "assets/icon.png", "LICENSE"]) {
      assert.ok(files.has(f), `${f} is not at the ZIP's root`);
    }
    const mcp = JSON.parse(files.get("mcp.json")!.toString("utf8"));
    const servers = Object.values(mcp.mcpServers) as any[];
    assert.equal(servers.length, 1);
    assert.equal(servers[0].url, READ_ENDPOINT);
    assert.equal(servers[0].url, "https://projectnoosphere.org/mcp/read");
    assert.equal(servers[0].type, "streamable-http");
    assert.equal(servers[0].headers, undefined);
    assert.deepEqual(servers[0].extensions["com.openai"].auth, { type: "none" });

    const manifest = JSON.parse(files.get("plugin.json")!.toString("utf8"));
    assert.equal(manifest.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
    assert.deepEqual(manifest.author, { name: "Randall Mills", email: "info@projectnoosphere.org", url: "https://projectnoosphere.org" });
    assert.equal(manifest.homepage, "https://projectnoosphere.org");
    const openai = manifest.extensions["com.openai"];
    assert.equal(openai.interface.privacyPolicyURL, "https://projectnoosphere.org/privacy");
    assert.equal(openai.interface.termsOfServiceURL, "https://projectnoosphere.org/terms");
    assert.deepEqual(files.get("assets/icon.png"), readFileSync(join(PLUGIN_DIR, "assets/icon.png")));
    assert.equal(openai.review.test_cases.positive.length, 5);
    assert.equal(openai.review.test_cases.negative.length, 3);
    assert.ok(openai.review.test_cases.positive.some((c: any) => c.expected_behavior.includes("--no-verify still runs prepare-commit-msg")));
    assert.ok(openai.review.test_cases.negative.some((c: any) => /read-only/.test(c.description) && c.description.includes("/agent-guide")));
    assert.equal(openai.review.demo_recording_url, undefined, "never invent a video URL");
    assert.ok(openai.publication.release_notes);
  });

  test("the package's review cases only name the read tools", () => {
    const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, "plugin.json"), "utf8"));
    const tools = manifest.extensions["com.openai"].review.test_cases.positive.flatMap((c: any) => c.tools_triggered.split(/,\s*/));
    assert.deepEqual([...new Set(tools)].sort(), ["get_revision", "search"]);
  });

  test("the skill is provider-neutral and read-only, and keeps the data rules", () => {
    const skill = readFileSync(join(PLUGIN_DIR, "skills/noosphere/SKILL.md"), "utf8");
    assert.doesNotMatch(skill, /\bClaude\b/);
    assert.match(skill, /untrusted data/);
    assert.match(skill, /never put\s+secrets/);
    assert.match(skill, /agent-guide/);
    for (const write of ["report_outcome", "annotate", "create_record", "propose_revision"]) {
      assert.ok(!skill.includes(`\`${write}\``), `the skill names the write tool ${write}`);
    }
  });

  test("a missing required file fails loudly and writes nothing", () => {
    const copy = join(scratch, "broken");
    cpSync(PLUGIN_DIR, copy, { recursive: true });
    rmSync(join(copy, "skills"), { recursive: true });
    const out = join(scratch, "broken.zip");
    assert.throws(() => buildPackage({ dir: copy, out }), /missing required file\(s\).*skills\/noosphere\/SKILL\.md/);
    assert.throws(() => readFileSync(out), /ENOENT/);
  });

  test("a manifest pointing anywhere but /mcp/read is refused", () => {
    const copy = join(scratch, "elsewhere");
    cpSync(PLUGIN_DIR, copy, { recursive: true });
    const path = join(copy, "mcp.json");
    const mcp = JSON.parse(readFileSync(path, "utf8"));
    mcp.mcpServers.noosphere.url = "https://projectnoosphere.org/mcp";
    writeFileSync(path, JSON.stringify(mcp));
    assert.throws(() => buildPackage({ dir: copy, out: join(scratch, "elsewhere.zip") }), /must be https:\/\/projectnoosphere\.org\/mcp\/read/);
  });

  test("a listing field over the portal's limit is refused", () => {
    const copy = join(scratch, "long");
    cpSync(PLUGIN_DIR, copy, { recursive: true });
    const path = join(copy, "plugin.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.extensions["com.openai"].interface.shortDescription = "Search open, versioned fixes that AI agents tested";
    writeFileSync(path, JSON.stringify(manifest));
    assert.throws(() => buildPackage({ dir: copy, out: join(scratch, "long.zip") }), /shortDescription is \d+ characters, more than 30/);
  });
});

// The manifest's server, driven against a real listening app with only the
// origin swapped: exactly the two read tools, and search works.
describe("OpenAI plugin's MCP entry", () => {
  let t: ReturnType<typeof setup>;
  let base: string;
  let published: string;
  before(async () => {
    t = setup();
    base = await t.app.listen({ host: "127.0.0.1", port: 0 });
    published = (await createRecordAs(t.app, t.a.token, sampleRecord({ title: "Platypus OpenAI plugin record" }))).revisionId;
    await publish(t.app, t.s.token, published);
  });
  after(() => t.close());

  test("lists exactly search and get_revision, and searches", async () => {
    const mcp = JSON.parse(readFileSync(join(PLUGIN_DIR, "mcp.json"), "utf8"));
    const url = new URL(new URL(mcp.mcpServers.noosphere.url).pathname, base);
    const client = new Client({ name: "openai-plugin-test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(url));
    assert.deepEqual((await client.listTools()).tools.map((x: any) => x.name).sort(), ["get_revision", "search"]);
    const r = await client.callTool({ name: "search", arguments: { query: "platypus" } });
    assert.ok((r.content as { text: string }[])[0]!.text.includes(published));
  });
});
