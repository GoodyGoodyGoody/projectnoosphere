// Builds the OpenAI plugin package (plugins/noosphere-openai) into one ZIP for
// upload to OpenAI's plugin portal. It uses OpenAI's portable Agent Plugins
// layout: plugin.json, mcp.json, skills/ and assets/ at the ZIP's root. Fails
// loudly, writing nothing, when a required file is missing, a field breaks the
// portal's submission limits, or mcp.json stops pointing at /mcp/read.
//
//   npm run package:openai [-- --out dist/noosphere-openai-plugin.zip]
//
// The ZIP is written by hand (node:zlib, deflate) so the build needs no zip
// tool on the machine. Timestamps are fixed, so the same files give the same ZIP.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { crc32, deflateRawSync } from "node:zlib";

const ROOT = join(import.meta.dirname, "..");
export const PLUGIN_DIR = join(ROOT, "plugins", "noosphere-openai");
export const DEFAULT_OUT = join(ROOT, "dist", "noosphere-openai-plugin.zip");
export const READ_ENDPOINT = "https://projectnoosphere.org/mcp/read";

export const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

export const REQUIRED_FILES = [
  "plugin.json",
  "mcp.json",
  "skills/noosphere/SKILL.md",
  "assets/icon.png",
  "README.md",
  "LICENSE",
];

// The portal's submission limits (OpenAI's "Manifest fields" reference).
const INTERFACE_LIMITS: Record<string, number> = {
  displayName: 30, shortDescription: 30, longDescription: 4000, developerName: 80,
  websiteURL: 1024, supportURL: 1024, privacyPolicyURL: 1024, termsOfServiceURL: 1024,
};

function fail(message: string): never {
  throw new Error(`package-openai-plugin: ${message}`);
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...listFiles(path));
    else out.push(path);
  }
  return out;
}

function readJson(dir: string, name: string): any {
  try { return JSON.parse(readFileSync(join(dir, name), "utf8")); } catch (err) {
    fail(`${name} does not parse: ${(err as Error).message}`);
  }
}

// Width and height from a PNG's IHDR chunk, or undefined if it isn't a PNG.
function pngSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.toString("latin1", 12, 16) !== "IHDR") return undefined;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// What the package must say, checked before anything is written.
export function checkPackage(dir: string): void {
  const files = new Set(listFiles(dir).map((f) => relative(dir, f).split(sep).join("/")));
  const missing = REQUIRED_FILES.filter((f) => !files.has(f));
  if (missing.length) fail(`missing required file(s) in ${dir}: ${missing.join(", ")}`);
  // The portal rejects ZIPs with app references or lifecycle hooks, and a
  // .codex-plugin overlay would be ignored next to extensions.com.openai.
  for (const f of files) {
    if (/^(\.app\.json|hooks\/|\.codex-plugin\/|\.mcp\.json$)/.test(f)) fail(`the package must not contain ${f}`);
  }

  const manifest = readJson(dir, "plugin.json");
  if (manifest.$schema !== PLUGIN_SCHEMA) fail(`plugin.json's $schema must be ${PLUGIN_SCHEMA}`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(manifest.name ?? "") || manifest.name.length > 64) fail("plugin.json's name must be kebab-case, at most 64 characters");
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version ?? "")) fail("plugin.json needs a semantic version");
  for (const field of ["description", "homepage", "license"]) {
    if (!manifest[field]) fail(`plugin.json has no ${field}`);
  }
  if (!manifest.author?.name || !manifest.author?.email) fail("plugin.json needs author.name and author.email");
  const openai = manifest.extensions?.["com.openai"];
  if (!openai || typeof openai !== "object") fail("plugin.json has no extensions.com.openai");
  if ("apps" in openai || "hooks" in openai) fail("extensions.com.openai must not declare apps or hooks");

  const ui = openai.interface ?? {};
  for (const [key, max] of Object.entries(INTERFACE_LIMITS)) {
    if (typeof ui[key] !== "string" || !ui[key]) fail(`interface.${key} is required`);
    if (ui[key].length > max) fail(`interface.${key} is ${ui[key].length} characters, more than ${max}`);
    if (key.endsWith("URL") && !ui[key].startsWith("https://")) fail(`interface.${key} must be HTTPS`);
  }
  if (!ui.category) fail("interface.category is required");
  const prompts = [ui.defaultPrompt ?? []].flat();
  if (prompts.length > 3 || prompts.some((p: string) => p.length > 128 || p.includes("@"))) fail("interface.defaultPrompt: at most three prompts, 128 characters each, no @mentions");
  for (const key of ["composerIcon", "logo"]) {
    const ref = ui[key];
    if (typeof ref !== "string" || !ref.startsWith("./")) fail(`interface.${key} must be a ./ path`);
    if (!files.has(ref.slice(2))) fail(`interface.${key} points at a missing file: ${ref}`);
    const data = readFileSync(join(dir, ref.slice(2)));
    const size = pngSize(data);
    if (!size) fail(`interface.${key} must be a PNG: ${ref}`);
    if (size.width !== size.height || size.width < 48 || size.width > 4096 || data.length > 5 * 1024 * 1024) {
      fail(`interface.${key} must be square, 48 to 4096 pixels and at most 5 MiB: ${ref} is ${size.width}x${size.height}`);
    }
  }

  const review = openai.review ?? {};
  const positive = review.test_cases?.positive ?? [];
  const negative = review.test_cases?.negative ?? [];
  if (positive.length !== 5) fail(`review.test_cases needs exactly five positive cases, found ${positive.length}`);
  if (negative.length !== 3) fail(`review.test_cases needs exactly three negative cases, found ${negative.length}`);
  const fields = (required: string[]) => (c: any) => {
    for (const field of required) {
      if (typeof c[field] !== "string" || !c[field]) fail(`a test case has no ${field}: ${JSON.stringify(c).slice(0, 80)}`);
    }
  };
  positive.forEach(fields(["description", "prompt", "tools_triggered", "expected_behavior"]));
  negative.forEach(fields(["description", "prompt"]));
  for (const c of positive) {
    for (const tool of c.tools_triggered.split(/,\s*/)) {
      if (!["search", "get_revision"].includes(tool)) fail(`a positive case triggers ${tool}, which /mcp/read does not have`);
    }
  }
  if ("test_credentials" in review || "reviewer_instructions" in review) fail("review must not contain test_credentials or reviewer_instructions");
  if (review.demo_recording_url !== undefined && !/^https:\/\//.test(review.demo_recording_url)) fail("review.demo_recording_url must be an HTTPS URL or left out");
  if (!openai.publication?.release_notes) fail("publication.release_notes is required");

  const mcp = readJson(dir, "mcp.json");
  if (mcp.$schema !== MCP_SCHEMA) fail(`mcp.json's $schema must be ${MCP_SCHEMA}`);
  const servers = Object.values(mcp.mcpServers ?? {}) as any[];
  if (servers.length !== 1) fail(`mcp.json must declare exactly one MCP server, found ${servers.length}`);
  const server = servers[0];
  if (server.type !== "streamable-http") fail("the MCP server's type must be streamable-http");
  if (server.url !== READ_ENDPOINT) fail(`the MCP server must be ${READ_ENDPOINT}, not ${server.url}`);
  if (server.headers !== undefined) fail("the MCP server must have no headers");
  if (server.extensions?.["com.openai"]?.auth?.type !== "none") fail("the MCP server's auth.type must be none");

  const skill = readFileSync(join(dir, "skills/noosphere/SKILL.md"), "utf8");
  if (!/^---\nname: [a-z0-9-]+\ndescription: .+\n---\n/.test(skill)) fail("SKILL.md needs name and description front matter");
  if (/\bClaude\b/.test(skill)) fail("SKILL.md must be provider-neutral (it mentions Claude)");
}

// A plain ZIP (deflate, UTF-8 names, no extra fields), entries in sorted order.
export function zip(entries: { name: string; data: Buffer }[]): Buffer {
  const DOS_TIME = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // a regular file, rw-r--r--
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, packed);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

export function buildPackage(opts: { dir?: string; out?: string } = {}): { out: string; files: string[] } {
  const dir = resolve(opts.dir ?? PLUGIN_DIR);
  const out = resolve(opts.out ?? DEFAULT_OUT);
  checkPackage(dir);
  const files = listFiles(dir).map((f) => relative(dir, f).split(sep).join("/")).sort();
  const body = zip(files.map((name) => ({ name, data: readFileSync(join(dir, name)) })));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, body);
  return { out, files };
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ args: process.argv.slice(2), options: { out: { type: "string" }, dir: { type: "string" } } });
    const { out, files } = buildPackage({ out: values.out, dir: values.dir });
    console.log(`wrote ${out}\n${files.map((f) => `  ${f}`).join("\n")}`);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
