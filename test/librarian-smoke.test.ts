import { test } from "node:test";
import assert from "node:assert/strict";
import { CANARIES, TRIAL_CANARIES, pickCanaries } from "../src/librarian/canaries.ts";
import { selectSmoke } from "../src/librarian/smoke-selection.ts";

test("trial canaries have unique synthetic IDs and never enter the nightly rotation", () => {
  assert.ok(TRIAL_CANARIES.length >= 2);
  const ids = [...CANARIES, ...TRIAL_CANARIES].map(c => c.payload.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const c of TRIAL_CANARIES) {
    assert.equal(c.expect, "not_publish");
    assert.match(String(c.payload.id), /^rev_01M3RC\d{20}$/);
  }
  for (let day = 0; day < 60; day++) {
    const date = new Date(Date.UTC(2026, 10, 26 + day)).toISOString();
    const picked = pickCanaries(date);
    assert.equal(picked.length, 3);
    assert.ok(picked.every(c => CANARIES.includes(c) && !TRIAL_CANARIES.includes(c)));
  }
});

test("--trial selects only trials and both production reviewers three times", () => {
  const selected = selectSmoke(["--trial"]);
  assert.equal(selected.canaries, TRIAL_CANARIES);
  assert.deepEqual(selected.reviewerLabels, ["opus-medium", "gpt-6-sol"]);
  assert.equal(selected.repetitions, 3);
  assert.deepEqual(selected.pairs, [["opus-medium", "gpt-6-sol"]]);
  const normal = selectSmoke([]);
  assert.equal(normal.canaries, CANARIES);
  assert.equal(normal.repetitions, 1);
  assert.deepEqual(normal.reviewerLabels, ["opus-medium", "opus-low", "gpt-6-sol", "gpt-5.4-mini"]);
});
