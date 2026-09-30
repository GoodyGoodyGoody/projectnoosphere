import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Canary } from "../src/librarian/canaries.ts";
import { NoosphereClient } from "../src/librarian/client.ts";
import { scriptedReviewer } from "../src/librarian/fake.ts";
import type { ReviewInput } from "../src/librarian/reviewer.ts";
import { runNight, type NightOptions } from "../src/librarian/run.ts";
import { SpendLedger } from "../src/librarian/spend.ts";
import { createRecordAs, sampleRecord, setup } from "./helpers.ts";

// A night runs review cycles until the queue is drained (ROADMAP "Librarian
// backlog"). What matters is where it STOPS: every stop condition below is one
// that, if missing, bills the same items again or spends past the run cap.
const canary = (name: string, expect: Canary["expect"], title: string): Canary => ({
  name, expect, kind: "revision",
  payload: { id: `rev_01M3NT${name.length.toString().padStart(20, "0")}`, kind: "procedure", title, summary: "s", body_markdown: "b" },
});
const CANARIES = [canary("bad", "not_publish", "CANARY-BAD"), canary("good", "publish", "CANARY-GOOD")];
const decide = (input: ReviewInput) =>
  input.user.includes("CANARY-BAD") ? ("reject" as const) : input.user.includes("CANARY-GOOD") ? ("publish" as const) : ("hold" as const);

describe("the librarian's night", () => {
  let t: ReturnType<typeof setup>;
  let base: string;
  let n = 0;
  // Every test gets its own rubric version, so the whole candidate pool is
  // undecided for it, and its own ledger and pause file.
  const opts = (over: Partial<NightOptions> = {}): NightOptions => {
    const dir = mkdtempSync(join(t.dir, "night-"));
    return {
      client: new NoosphereClient(base, t.s.token),
      primary: scriptedReviewer("fake/a", decide),
      second: scriptedReviewer("fake/b", decide),
      rubricVersion: `night-${++n}`,
      ledger: new SpendLedger(join(dir, "spend.jsonl")),
      monthlyCapUsd: 1000, runCapUsd: 1000,
      pauseFile: join(dir, "librarian.paused"),
      notify: () => {},
      canaries: CANARIES,
      limit: 2,
      ...over,
    };
  };
  const pending = async (rubric: string) => {
    const q = await new NoosphereClient(base, t.s.token).queue(rubric, 100);
    return q.revisions.length + q.annotations.length;
  };

  before(async () => {
    t = setup();
    base = await t.app.listen({ host: "127.0.0.1", port: 0 });
    for (let i = 0; i < 5; i++) await createRecordAs(t.app, t.a.token, sampleRecord({ title: `Night item ${i}` }));
  });
  after(() => t.close());

  test("a queue bigger than one cycle is drained in several passes", async () => {
    const o = opts();
    const before = await pending(o.rubricVersion);
    assert.ok(before >= 5);
    const night = await runNight(o);
    assert.equal(night.stoppedBecause, "queue drained");
    assert.equal(night.reviewed + night.superseded, before);
    assert.ok(night.passes >= Math.ceil(before / 2), `only ${night.passes} passes for ${before} items`);
    assert.equal(night.backlogRemaining, false);
    assert.equal(await pending(o.rubricVersion), 0);
    assert.equal(night.canaries.length, 2 * night.passes, "every pass verifies its own canaries");
  });

  test("the run cap covers the whole night, not each pass", async () => {
    // $1 per call, two reviewers: $2 per item, $4 for a pass's two canaries.
    // Pass 1: canaries + 2 items = $8. Pass 2 has $5 left: canaries ($4), then
    // the next item would cross the cap. Without the carry, pass 2 spends $8.
    const o = opts({
      primary: scriptedReviewer("paid/a", decide, 1),
      second: scriptedReviewer("paid/b", decide, 1),
      runCapUsd: 13,
    });
    const night = await runNight(o);
    assert.equal(night.stoppedBecause, "run budget");
    assert.equal(night.passes, 2);
    assert.ok(night.spendRunUsd <= 13, `spent $${night.spendRunUsd} against a $13 cap`);
    assert.equal(night.spendRunUsd, 12);
    assert.equal(night.backlogRemaining, true);
  });

  test("apply errors stop the night after one pass", async () => {
    class Failing extends NoosphereClient {
      override async moderate() { return { status: 500, body: { error: { code: "boom" } } }; }
    }
    const night = await runNight(opts({ client: new Failing(base, t.s.token) }));
    assert.equal(night.stoppedBecause, "apply errors");
    assert.equal(night.passes, 1);
  });

  test("an item that comes back stops the night before another pass is paid for", async () => {
    // Applies "succeed" but record nothing (as a dry run does), so the same
    // items return. The peek must catch it before pass 2 runs its canaries.
    class Silent extends NoosphereClient {
      override async moderate() { return { status: 201, body: {} }; }
    }
    const o = opts({ client: new Silent(base, t.s.token) });
    const night = await runNight(o);
    assert.match(night.stoppedBecause, /^no progress/);
    assert.equal(night.passes, 1);
    assert.equal(night.canaries.length, 2, "no second pass of canaries");
  });

  test("maxPasses is a backstop, and reports the backlog", async () => {
    const night = await runNight(opts({ maxPasses: 1 }));
    assert.equal(night.stoppedBecause, "max passes");
    assert.equal(night.passes, 1);
    assert.equal(night.backlogRemaining, true);
  });

  test("a paused librarian does nothing at all", async () => {
    const o = opts();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(o.pauseFile, "paused for the test\n");
    const night = await runNight(o);
    assert.equal(night.stoppedBecause, "paused");
    assert.equal(night.passes, 1);
    assert.equal(night.reviewed, 0);
  });
});
