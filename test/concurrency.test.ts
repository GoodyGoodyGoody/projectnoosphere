import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { bearer, count, createRecordAs, propose, publish, sampleRecord, setup } from "./helpers.ts";

const WORKER = join(import.meta.dirname, "fixtures", "inject-worker.ts");
// Loading the app takes ~0.75 s alone but far longer on a busy machine (a fixed
// 5 s from launch failed at load ~5–8, 2026-11-25/27), so the start time is set
// only once every worker reports ready. The limit is generous and fails clearly.
const READY_LIMIT_MS = 60_000;
const RESULT_LIMIT_MS = 30_000;
const START_DELAY_MS = 300;

type WorkerResult = { status: number; body: any; replayed: string | null; elapsedMs: number; late: boolean };
type Worker = { child: ChildProcess; ready: Promise<void>; done: Promise<string> };

function launch(dbPath: string, request: object, env: NodeJS.ProcessEnv, i: number): Worker {
  const child = spawn(process.execPath, [WORKER, dbPath, JSON.stringify(request)], { env, stdio: ["pipe", "pipe", "pipe"] });
  // A worker that died after reporting ready fails through `done`; don't let
  // the write of its start time crash the test runner with EPIPE instead.
  child.stdin!.on("error", () => {});
  let out = "";
  let err = "";
  let markReady!: () => void;
  let failReady!: (e: Error) => void;
  const ready = new Promise<void>((res, rej) => { markReady = res; failReady = rej; });
  const done = new Promise<string>((res, rej) => {
    child.stdout!.on("data", (c) => {
      out += String(c);
      if (out.startsWith("ready\n")) markReady();
    });
    child.stderr!.on("data", (c) => { err += String(c); });
    child.on("error", (e) => { failReady(e); rej(e); });
    child.on("close", (code, signal) => {
      const e = new Error(`worker ${i} exited (code ${code}, signal ${signal}) before finishing:\n${err}`);
      failReady(e); // no-op once ready
      if (code === 0 && out.startsWith("ready\n")) res(out.slice("ready\n".length));
      else rej(e);
    });
  });
  ready.catch(() => {});
  done.catch(() => {});
  return { child, ready, done };
}

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const limit = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(what)), ms); });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

// Separate OS processes on one SQLite file, released at the same instant —
// the situation PM2 cluster mode creates. In-process tests cannot show this.
async function race(dbPath: string, requests: object[], holdMs = 0) {
  const env = { ...process.env, HOLD_MS: String(holdMs) };
  const workers = requests.map((r, i) => launch(dbPath, r, env, i));
  try {
    await within(
      Promise.all(workers.map((w) => w.ready)),
      READY_LIMIT_MS,
      `not every worker loaded the app and reported ready within ${READY_LIMIT_MS} ms`,
    );
    // Everyone is loaded and waiting: release them together a short moment ahead.
    const startAt = Date.now() + START_DELAY_MS;
    for (const w of workers) w.child.stdin!.end(`${startAt}\n`);
    const outs = await within(
      Promise.all(workers.map((w) => w.done)),
      RESULT_LIMIT_MS,
      `not every worker finished its request within ${RESULT_LIMIT_MS} ms of the start time`,
    );
    const results = outs.map((o) => JSON.parse(o) as WorkerResult);
    assert.ok(results.every((r) => !r.late), "a worker started after the shared start time; the race did not happen");
    return results;
  } finally {
    for (const w of workers) if (w.child.exitCode === null && w.child.signalCode === null) w.child.kill("SIGKILL");
  }
}

// Proof the race happened: with each transaction held HOLD ms, requests that
// overlapped must queue behind each other, so the slowest takes ≥ ~2×HOLD.
// Requests that merely ran one after another would each take ~HOLD.
function assertContended(results: { elapsedMs: number }[], holdMs: number) {
  const slowest = Math.max(...results.map((r) => r.elapsedMs));
  assert.ok(slowest >= 1.8 * holdMs, `no contention observed (slowest ${slowest} ms, hold ${holdMs} ms)`);
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
      // Distinct Idempotency-Keys route each publish through the hold, so all
      // three transactions are genuinely in flight together.
      const results = await race(dbPath, candidates.map((id, i) => ({
        method: "POST", url: "/api/v1/admin/moderation-events",
        headers: { ...bearer(t.s.token), "idempotency-key": `race-${round}-${i}` },
        payload: { action: "publish_revision", target_id: id, reason: `race round ${round}` },
      })), 300);
      assertContended(results, 300);
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
    // Proof of overlap: a replay does no work and skips the hold, so it returns in
    // a few ms — unless it was queued behind the first request's open transaction.
    const replays = results.filter((r) => r.replayed === "true");
    assert.ok(
      replays.every((r) => r.elapsedMs >= 0.8 * 300),
      `replays did not wait for the in-flight write: ${JSON.stringify(replays.map((r) => r.elapsedMs))} ms`,
    );
    assert.ok(results.every((r) => r.status === 201), JSON.stringify(results.map((r) => r.status)));
    assert.equal(new Set(results.map((r) => r.body.record.id)).size, 1);
    assert.equal(results.filter((r) => r.replayed === "true").length, 2);
    assert.equal(count(t.db, "records"), before + 1);
  });
});
