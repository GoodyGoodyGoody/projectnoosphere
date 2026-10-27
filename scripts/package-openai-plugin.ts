// Builds the OpenAI plugin package (plugins/noosphere-openai) into one ZIP for
// upload to OpenAI's plugin portal. The files sit at the ZIP's root, with
// .codex-plugin/plugin.json at the top. Fails loudly, writing nothing, when a
// required file is missing or the manifest stops pointing at /mcp/read.
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

export const REQUIRED_FILES = [
  ".codex-plugin/plugin.json",
  "skills/noosphere/SKILL.md",
  "assets/icon.png",
  "submission/review.json",
  "README.md",
  "LICENSE",
];

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

// What the package must say, checked before anything is written.
export function checkPackage(dir: string): void {
  const files = new Set(listFiles(dir).map((f) => relative(dir, f).split(sep).join("/")));
  const missing = REQUIRED_FILES.filter((f) => !files.has(f));
  if (missing.length) fail(`missing required file(s) in ${dir}: ${missing.join(", ")}`);

  let manifest: any;
  try { manifest = JSON.parse(readFileSync(join(dir, ".codex-plugin/plugin.json"), "utf8")); } catch (err) {
    fail(`.codex-plugin/plugin.json does not parse: ${(err as Error).message}`);
  }
  for (const field of ["name", "version", "description", "author", "homepage", "license"]) {
    if (!manifest[field]) fail(`plugin.json has no ${field}`);
  }
  const servers = Object.values(manifest.mcpServers ?? {}) as any[];
  if (servers.length !== 1) fail(`plugin.json must declare exactly one MCP server, found ${servers.length}`);
  if (servers[0].url !== READ_ENDPOINT) fail(`the MCP server must be ${READ_ENDPOINT}, not ${servers[0].url}`);
  if (servers[0].headers || servers[0].auth) fail("the MCP server must have no authentication");
  for (const key of ["composerIcon", "logo"]) {
    const ref = manifest.interface?.[key];
    if (typeof ref === "string" && !files.has(ref.replace(/^\.\//, ""))) fail(`interface.${key} points at a missing file: ${ref}`);
  }

  const skill = readFileSync(join(dir, "skills/noosphere/SKILL.md"), "utf8");
  if (!/^---\nname: [a-z0-9-]+\ndescription: .+\n---\n/.test(skill)) fail("SKILL.md needs name and description front matter");
  if (/\bClaude\b/.test(skill)) fail("SKILL.md must be provider-neutral (it mentions Claude)");

  let review: any;
  try { review = JSON.parse(readFileSync(join(dir, "submission/review.json"), "utf8")); } catch (err) {
    fail(`submission/review.json does not parse: ${(err as Error).message}`);
  }
  if (review.test_cases?.positive?.length !== 5) fail("review.json needs exactly five positive test cases");
  if (review.test_cases?.negative?.length !== 3) fail("review.json needs exactly three negative test cases");
  for (const c of [...review.test_cases.positive, ...review.test_cases.negative]) {
    for (const field of ["scenario", "user_prompt", "expected_tools", "expected_result"]) {
      if (c[field] === undefined || c[field] === "") fail(`a test case has no ${field}: ${JSON.stringify(c).slice(0, 80)}`);
    }
  }
  if (!review.release_notes) fail("review.json has no release_notes");
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
