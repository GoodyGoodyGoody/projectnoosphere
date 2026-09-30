import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

const CLI = join(import.meta.dirname, "..", "scripts", "librarian.ts");
// A clean environment: no inherited SITE_DATA_DIR, and no repo .env.
const run = (args: string[], env: Record<string, string>) =>
  spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: { PATH: process.env.PATH ?? "", NOOSPHERE_ENV_FILE: "/nonexistent/.env", ...env },
  });

describe("librarian CLI: the kill switch works across processes", () => {
  let dir: string;
  before(() => { dir = mkdtempSync(join(tmpdir(), "noosphere-cli-")); });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("refuses to run without an absolute SITE_DATA_DIR", () => {
    for (const env of [{}, { SITE_DATA_DIR: "relative/dir" }] as Record<string, string>[]) {
      const res = run(["status"], env);
      assert.equal(res.status, 2, JSON.stringify(env));
      assert.match(res.stderr, /SITE_DATA_DIR must be set/);
    }
  });

  test("pause in one process is seen by status and by run in others", () => {
    const env = { SITE_DATA_DIR: dir };
    assert.equal(run(["pause", "investigating"], env).status, 0);
    const status = run(["status"], env);
    assert.match(status.stdout, /PAUSED — .*investigating/);
    // A run while paused does nothing (the API is never contacted).
    const cycle = run(["run", "--dry-run"], { ...env, NOOSPHERE_LIBRARIAN_TOKEN: "nsp_unused", NOOSPHERE_API_BASE: "http://127.0.0.1:9" });
    assert.equal(cycle.status, 0, cycle.stderr);
    assert.match(cycle.stdout, /"paused": "paused .*investigating/);
    assert.equal(run(["resume"], env).status, 0);
    assert.match(run(["status"], env).stdout, /^data: .*\nactive/m);
  });
});
