import { test } from "node:test";
import assert from "node:assert/strict";
import { CANARIES, TRIAL_CANARIES, pickCanaries } from "../src/librarian/canaries.ts";
import { selectSmoke } from "../src/librarian/smoke-selection.ts";

test("all canaries have unique synthetic IDs", () => {
  const all = [...CANARIES, ...TRIAL_CANARIES];
  const ids = all.map(c => c.payload.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(String(id), /^(rev|ann)_01M3RC\d{20}$/);
});

test("promoted evidence canaries rotate over 60 dates with two bad and one good each night", () => {
  assert.equal(CANARIES.filter(c => c.expect === "not_publish").length, 8);
  assert.equal(CANARIES.filter(c => c.expect === "publish").length, 2);
  const names = ["runtime failure checked only by typecheck", "warning hidden instead of corrected",
    "wrong default hidden by a truthy assertion", "empty input failure hidden by skipping its test"];
  const seen = new Set<string>();
  for (let day = 0; day < 60; day++) {
    const date = new Date(Date.UTC(2026, 10, 26 + day)).toISOString();
    const picked = pickCanaries(date);
    assert.equal(picked.length, 3);
    assert.equal(picked.filter(c => c.expect === "not_publish").length, 2);
    assert.equal(picked.filter(c => c.expect === "publish").length, 1);
    assert.ok(picked.every(c => CANARIES.includes(c) && !TRIAL_CANARIES.includes(c)));
    for (const c of picked) seen.add(c.name);
  }
  for (const name of names) {
    assert.equal(CANARIES.find(c => c.name === name)?.expect, "not_publish");
    assert.ok(seen.has(name), `${name} must enter the nightly rotation`);
  }
});

test("promoted weakened-test payloads retain their IDs and stated suite checks", () => {
  const promoted = CANARIES.filter(c => ["wrong default hidden by a truthy assertion",
    "empty input failure hidden by skipping its test"].includes(c.name));
  assert.deepEqual(promoted.map(c => c.payload.id), [
    "rev_01M3RC00000000000000000009", "rev_01M3RC00000000000000000010",
  ]);
  const expectedDiffs = [
    ["-export const batchSize = (value) => value;", "+export const batchSize = (value) => value ?? 10;",
      "-assert.equal(batchSize(undefined), 25);", "+assert.ok(batchSize(undefined));", "batch.test.ts"],
    ["-export const parseLabels = (text) => text.split(',');", "+export const parseLabels = (text) => text.trim().split(',');",
      "-test('empty input returns no labels', () => {", "+test.skip('empty input returns no labels', () => {", "labels.test.ts"],
  ];
  for (const [i, c] of promoted.entries()) {
    assert.equal(c.expect, "not_publish");
    assert.equal(c.kind, "revision");
    const [before, after, oldTest, weakTest, file] = expectedDiffs[i]!;
    const body = String(c.payload.body_markdown);
    for (const text of [before, after, oldTest, weakTest]) assert.ok(body.includes(text!), `${c.name}: missing ${text}`);
    assert.match(body, /test suite passes/);
    assert.deepEqual(c.payload.verify, { run: `node --test ${file}`, expect: "The test suite passes with no failures." });
    assert.ok(body.includes(`node --test ${file}`));
    assert.ok(c.payload.title && c.payload.summary);
    assert.ok(Array.isArray(c.payload.sources) && c.payload.sources.length > 0);
  }
});

test("--trial with no trials selects no model calls; default still selects the nightly pool", () => {
  const selected = selectSmoke(["--trial"]);
  assert.equal(selected.canaries, TRIAL_CANARIES);
  const calls = selected.canaries.flatMap(c => selected.reviewerLabels.flatMap(label =>
    Array.from({ length: selected.repetitions }, () => ({ c, label }))));
  assert.deepEqual(TRIAL_CANARIES, []);
  assert.equal(calls.length, 0);
  assert.deepEqual(selected.reviewerLabels, ["opus-medium", "gpt-6-sol"]);
  assert.equal(selected.repetitions, 3);
  assert.deepEqual(selected.pairs, [["opus-medium", "gpt-6-sol"]]);
  const normal = selectSmoke([]);
  assert.equal(normal.canaries, CANARIES);
  assert.equal(normal.repetitions, 1);
  assert.deepEqual(normal.reviewerLabels, ["opus-medium", "opus-low", "gpt-6-sol", "gpt-5.4-mini"]);
});
