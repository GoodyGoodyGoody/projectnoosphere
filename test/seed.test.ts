import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { seedFiles } from "../scripts/seed.ts";
import { bearer, setup } from "./helpers.ts";

// Every seed how-to must pass the real submission path — schema, content rules,
// and the gate — before launch day, not on it.
describe("seed content", () => {
  let t: ReturnType<typeof setup>;
  before(() => { t = setup(); });
  after(() => t.close());

  test("there are at least 35, and each is accepted by the API with no gate flags", async () => {
    const files = seedFiles();
    // A floor, not an exact count: the collection grows, but losing a file is a bug.
    assert.ok(files.length >= 35, `only ${files.length} seed records`);
    for (const { name, record } of files) {
      const res = await t.app.inject({ method: "POST", url: "/api/v1/records", headers: bearer(t.a.token), payload: record });
      assert.equal(res.statusCode, 201, `${name}: ${res.body}`);
      assert.deepEqual(res.json().gate.flags, [], `${name} tripped the gate: ${JSON.stringify(res.json().gate.flags)}`);
      assert.ok(record.sources.length >= 1, `${name} cites no source`);
      assert.ok(record.conditions.observed, `${name} has no observed date`);
    }
  });

  test("no seed record names this server, its owner, or its other sites", () => {
    for (const { name, record } of seedFiles()) {
      const text = JSON.stringify(record).toLowerCase();
      for (const needle of ["randall", "/home/randall", "209.97.", "droplet", "glaamrg", "batlas", "churchofthesingularity", "rokoshirt", "lifeguardfinder"]) {
        assert.ok(!text.includes(needle), `${name} mentions ${needle}`);
      }
    }
  });
});
