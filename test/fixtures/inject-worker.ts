// A separate OS process with its own app instance and its own connection to the
// same SQLite file — what PM2 cluster workers are. Waits until a shared start
// time so several workers hit the database together, performs one request, and
// prints the result as JSON.
import { buildApp } from "../../src/app.ts";
import { openDb } from "../../src/db.ts";

const [dbPath, startAt, requestJson] = process.argv.slice(2);
if (!dbPath || !startAt || !requestJson) throw new Error("usage: inject-worker DB START_AT_MS REQUEST_JSON");
const db = openDb(dbPath);
// HOLD_MS keeps each idempotent transaction open after its lookup, forcing overlap.
const holdMs = Number(process.env.HOLD_MS ?? 0);
const hold = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
const app = buildApp({ db, ...(holdMs > 0 ? { testHooks: { idempotencyAfterLookup: hold } } : {}) });
await app.ready();
const wait = Number(startAt) - Date.now();
if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
const res = await app.inject(JSON.parse(requestJson));
process.stdout.write(
  JSON.stringify({ status: res.statusCode, body: res.json(), replayed: res.headers["idempotent-replayed"] ?? null }),
);
await app.close();
db.close();
