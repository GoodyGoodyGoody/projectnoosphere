import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";
import { bearer, count, createRecordAs, propose, publish, sampleRecord, setup } from "./helpers.ts";

const run = promisify(execFile);
const WORKER = join(import.meta.dirname, "fixtures", "inject-worker.ts");

// Separate OS processes on one SQLite file, released at the same instant —
// the situation PM2 cluster mode creates. In-process tests cannot show this.
async function race(dbPath: string, requests: object[], holdMs = 0) {
  const startAt = Date.now() + 1500;
  const env = { ...process.env, HOLD_MS: String(holdMs) };
  const outs = await Promise.all(
    requests.map((r) =>
      run(process.execPath, [WORKER, dbPath, String(startAt), JSON.stringify(r)], { timeout: 20_000, env }),
    ),
  );
  return outs.map((o) => JSON.parse(o.stdout) as { status: number; body: any; replayed: string | null });
}

describe("concurrency across processes", () => {
  let t: ReturnType<typeof setup>;
  let dbPath: string;
  before(() => {
    t = setup();
    dbPath = join(t.dir, "test.sqlite");
  });
  after(() => t.close());

  test("three processes publish three competing candidates: exactly one wins, every round", async () => {
    const { recordId, revisionId } = await createRecordAs(t.app, t.a.token);
    await publish(t.app, t.s.token, revisionId);
    let base = revisionId;
    for (let round = 0; round < 3; round++) {
      const candidates: string[] = [];
      for (const who of [t.a, t.b, t.a]) {
        candidates.push((await propose(t.app, who.token, recordId, base, { title: `Round ${round} edit` })).json().revision.id);
      }
      const results = await race(dbPath, candidates.map((id) => ({
        method: "POST", url: "/api/v1/admin/moderation-events", headers: bearer(t.s.token),
        payload: { action: "publish_revision", target_id: id, reason: `race round ${round}` },
      })));
      const winners = results.filter((r) => r.status === 201);
      const losers = results.filter((r) => r.status === 409);
      assert.equal(winners.length, 1, JSON.stringify(results.map((r) => r.status)));
      assert.equal(losers.length, 2);
      assert.ok(losers.every((r) => r.body.error.code === "stale_base"));
      const winner = winners[0]!.body.event.published_revision_id;
      const rec = (await t.app.inject({ url: `/api/v1/records/${recordId}` })).json();
      assert.equal(rec.record.current_revision_id, winner);
      base = winner;
    }
  });

  test("three processes send the same Idempotency-Key at once: one record, identical responses", async () => {
    const before = count(t.db, "records");
    const req = {
      method: "POST", url: "/api/v1/records",
      headers: { ...bearer(t.a.token), "idempotency-key": "parallel-retry" }, payload: sampleRecord(),
    };
    // Each process holds its transaction 300 ms after the lookup, so all three are
    // in flight together; only IMMEDIATE transactions make the 2nd and 3rd wait.
    const results = await race(dbPath, [req, req, req], 300);
    assert.ok(results.every((r) => r.status === 201), JSON.stringify(results.map((r) => r.status)));
    assert.equal(new Set(results.map((r) => r.body.record.id)).size, 1);
    assert.equal(results.filter((r) => r.replayed === "true").length, 2);
    assert.equal(count(t.db, "records"), before + 1);
  });
});
