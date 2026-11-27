// A separate OS process with its own app instance and its own connection to the
// same SQLite file — what PM2 cluster workers are. Loads the app, prints
// "ready" on stdout, then reads the shared start time from stdin and waits for
// it, so several workers hit the database together. Performs one request and
// prints the result as JSON on the next line.
import { buildApp } from "../../src/app.ts";
import { openDb } from "../../src/db.ts";

const [dbPath, requestJson] = process.argv.slice(2);
if (!dbPath || !requestJson) throw new Error("usage: inject-worker DB REQUEST_JSON (start time on stdin after 'ready')");
const db = openDb(dbPath);
// HOLD_MS keeps each idempotent transaction open after its lookup, forcing overlap.
const holdMs = Number(process.env.HOLD_MS ?? 0);
const hold = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
const app = buildApp({ db, ...(holdMs > 0 ? { testHooks: { idempotencyAfterLookup: hold } } : {}) });
await app.ready();
// Readiness barrier: the parent sets the start time only once every worker has
// loaded, so slow loading on a busy machine cannot make a worker miss it.
process.stdout.write("ready\n");
let line = "";
for await (const chunk of process.stdin) {
  line += String(chunk);
  if (line.includes("\n")) break;
}
const startAt = Number(line.trim());
if (!Number.isFinite(startAt) || startAt <= 0) throw new Error(`bad start time on stdin: ${JSON.stringify(line)}`);
const wait = startAt - Date.now();
// Arriving after the start time means this process could not overlap with the
// others; the test must fail on that plainly, not as a confusing race result.
const late = wait <= 0;
if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
const t0 = Date.now();
const res = await app.inject(JSON.parse(requestJson));
const elapsedMs = Date.now() - t0;
process.stdout.write(
  JSON.stringify({
    status: res.statusCode,
    body: res.json(),
    replayed: res.headers["idempotent-replayed"] ?? null,
    elapsedMs,
    late,
  }) + "\n",
);
await app.close();
db.close();
