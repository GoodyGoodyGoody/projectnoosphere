import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CANARIES } from "../src/librarian/canaries.ts";
import { CATCH_NOTES, DRAFT_PROMPT, TRIAL_REVIEWERS, openTrialDb, parseDraft, parseJudgement,
  runReviewerCheckTrial, saveTrialReport, selectTrialItems, trialInput, trialTable,
  type TrialInput, type TrialReviewer, type TrialItem } from "../src/librarian/reviewer-check-trial.ts";
import { selectSmoke } from "../src/librarian/smoke-selection.ts";
import { SpendLedger } from "../src/librarian/spend.ts";
import { createRecordAs, publishedRecord, setup } from "./helpers.ts";

const draft = { promise: "Blank input yields no labels.", run: "labels-cli --input '' --json", expect: "The output deep-equals []", no_check: null };
const noCheck = { promise: "No observable technical fix is stated.", run: null, expect: null, no_check: "Only advertising; no offline technical behaviour to check." };
const judgement = { verdict: "accepts", reason: "The independent observation tests the promise." };
const item: TrialItem = { id: "fixture", kind: "revision", source: "published", payload: { title: "Fixture", body_markdown: "Input produces no labels." } };

test("draft parser enforces observable results, limits, exact shape and no_check", () => {
  assert.deepEqual(parseDraft(draft), draft);
  assert.deepEqual(parseDraft(noCheck), noCheck);
  for (const expect of ["ok", "OK!", "'ok'", "exit code 0", "Exited with code 0.", "passed"]) assert.equal(parseDraft({ ...draft, expect }), null);
  for (const invalid of [{ ...draft, run: " " }, { ...draft, run: "x".repeat(2001) },
    { ...draft, expect: "x".repeat(4001) }, { ...noCheck, run: "echo hi" }, { ...draft, catch: "leak" }]) assert.equal(parseDraft(invalid), null);
  assert.equal(parseJudgement({ verdict: "accepts", reason: "" }), null);
  assert.equal(parseJudgement({ verdict: "publish", reason: "yes" }), null);
  assert.deepEqual(parseJudgement(judgement), judgement);
  assert.match(DRAFT_PROMPT, /NEVER from the author's test/);
  assert.match(DRAFT_PROMPT, /must not reuse or depend on the files the fix edits/);
});

test("--reviewer-checks selects 8 bad canaries and 10 deterministic current published revisions read-only", async () => {
  const t = setup();
  try {
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push((await publishedRecord(t, t.a.token, { title: `Published ${i}` })).revisionId);
    // Exclude unpublished and non-reviewed current revisions even though newer.
    await createRecordAs(t.app, t.a.token);
    const excluded = await publishedRecord(t, t.a.token, { title: "Withheld newest" });
    t.db.prepare("UPDATE revision_review SET state='quarantined' WHERE revision_id=?").run(excluded.revisionId);
    const ro = openTrialDb(join(t.dir, "test.sqlite"));
    try {
      assert.throws(() => ro.exec("CREATE TABLE should_fail (id TEXT)"), /readonly/i);
      assert.throws(() => ro.prepare("UPDATE revision_review SET reason='write' ").run(), /readonly/i);
      assert.equal(selectSmoke(["--reviewer-checks"]).reviewerChecks, true);
      assert.equal(selectSmoke([]).reviewerChecks, false);
      assert.throws(() => selectSmoke(["--reviewer-checks", "--trial"]), /alone/);
      const items = selectTrialItems(ro);
      assert.deepEqual(selectTrialItems(ro), items);
      assert.equal(items.length, 18);
      assert.deepEqual(items.filter((i) => i.source === "canary").map((i) => i.id), CANARIES.filter((c) => c.expect === "not_publish").map((c) => c.name));
      // These sequentially generated ids sort in creation order, including timestamp ties.
      const expected = ids.sort().reverse().slice(0, 10);
      assert.deepEqual(items.filter((i) => i.source === "published").map((i) => i.id), expected);
      assert.deepEqual(Object.keys(CATCH_NOTES).sort(), items.filter((i) => i.source === "canary").map((i) => i.id).sort());
      for (const selected of items) {
        const sent = trialInput(selected).user + trialInput(selected, draft).user;
        for (const note of Object.values(CATCH_NOTES)) assert.ok(!sent.includes(note), "answer key must never reach a reviewer");
        assert.ok(!sent.includes('"source":"canary"'));
      }
      const requests: { id: string; input: TrialInput }[] = [];
      const reviewers = TRIAL_REVIEWERS.map((config): TrialReviewer => ({
        id: config.id, maxCostUsd: () => 0.001,
        async call(input) {
          requests.push({ id: config.id, input });
          return { value: input.system.includes("Judge the other") ? judgement : draft,
            usage: { inputTokens: 20, outputTokens: 40 }, costUsd: 0.001, status: "ok" };
        },
      })) as [TrialReviewer, TrialReviewer];
      const ledger = new SpendLedger(join(t.dir, "librarian-spend.jsonl"));
      const report = await runReviewerCheckTrial({ items, reviewers, ledger, save: (r) => { saveTrialReport(t.dir, "fixture", r); } });
      assert.equal(requests.length, 72);
      assert.equal(report.rows.length, 36);
      assert.equal(report.stoppedBecause, null);
      for (const row of report.rows) { assert.notEqual(row.reviewer, row.judge); assert.deepEqual(row.judgement, judgement); }
      assert.deepEqual(requests.slice(0, 4).map((r) => r.id), [reviewers[0].id, reviewers[1].id, reviewers[1].id, reviewers[0].id]);
      assert.deepEqual(TRIAL_REVIEWERS.map((r) => [r.model, r.effort, r.maxTokens]), [["claude-opus-5-5", "medium", 4000], ["gpt-6-sol", "medium", 4000]]);
      const saved = JSON.parse(readFileSync(join(t.dir, "trials/reviewer-checks/fixture.json"), "utf8"));
      assert.deepEqual(saved, report);
      assert.equal(readFileSync(ledger.path, "utf8").trim().split("\n").length, 72);
      assert.ok(Math.abs(ledger.monthTotal(report.startedAt.slice(0, 7)) - report.spentUsd) < 1e-10);
      assert.match(trialTable(report), /promise \| run \| expect/);
      assert.match(trialTable(report), /accepts: The independent/);
    } finally { ro.close(); }
  } finally { await t.close(); }
});

test("inadequate sample fails before any paid call", async () => {
  const t = setup();
  try { assert.throws(() => selectTrialItems(t.db), /requires 10 published revisions; found 0/); }
  finally { await t.close(); }
});

test("spend stop reserves worst-case cost before $1, persists partial rows and bills no_check", async () => {
  const t = setup();
  try {
    let calls = 0;
    const reviewer = (id: string): TrialReviewer => ({ id, maxCostUsd: () => 0.25,
      async call(input) { calls++; return { value: input.system.includes("Judge the other") ? judgement : noCheck,
        usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0.25, status: "ok" }; } });
    const ledger = new SpendLedger(join(t.dir, "ledger.jsonl"));
    const report = await runReviewerCheckTrial({ items: [item], reviewers: [reviewer("a"), reviewer("b")], ledger, save() {} });
    assert.equal(calls, 3);
    assert.equal(report.spentUsd, 0.75);
    assert.equal(report.stoppedBecause, "stopped before $1 cap");
    assert.equal(report.rows[1]!.judgeStatus, "not_called");
    assert.deepEqual(report.rows[0]!.draft, noCheck);
    assert.equal(readFileSync(ledger.path, "utf8").trim().split("\n").length, 3);
  } finally { await t.close(); }
});

test("unknown-cost errors stop without retries; malformed responses are billed and never judged", async () => {
  const t = setup();
  try {
    let calls = 0;
    const bad: TrialReviewer = { id: "bad", maxCostUsd: () => 0.1, async call() { calls++; throw new Error("timeout"); } };
    const malformed: TrialReviewer = { id: "malformed", maxCostUsd: () => 0.1,
      async call() { calls++; return { value: { ...draft, expect: "ok" }, costUsd: 0.01, usage: { inputTokens: 1, outputTokens: 1 }, status: "ok" }; } };
    const ledger = new SpendLedger(join(t.dir, "ledger.jsonl"));
    const error = await runReviewerCheckTrial({ items: [item], reviewers: [bad, malformed], ledger, save() {} });
    assert.equal(calls, 1);
    assert.equal(error.reservedUsd, 0.1);
    assert.match(error.stoppedBecause!, /cost may be unknown/);
    calls = 0;
    const invalid = await runReviewerCheckTrial({ items: [item], reviewers: [malformed, malformed], ledger, save() {} });
    assert.equal(calls, 2);
    assert.ok(invalid.rows.every((r) => r.draftStatus === "invalid" && r.judgeStatus === "not_called"));
    assert.equal(invalid.spentUsd, 0.02);
  } finally { await t.close(); }
});
