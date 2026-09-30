import { join } from "node:path";

// The one place this app resolves where its runtime data lives.
//
// SITE_DATA_DIR is set, absolutely, in ecosystem.config.js. It must be absolute
// because Next's standalone output chdir's into `.next/standalone`, so at
// runtime `process.cwd()` is the BUILD OUTPUT, not the repo root. Anything
// cwd-relative therefore points somewhere that is wiped by the next deploy — or
// does not exist at all. That single mistake hit three sites independently
// before it was caught: church served 404s for every sermon image for 27 hours,
// mailroom read a domains.json that had never existed, and rokoshirt wrote
// Stripe order records into the build output.
//
// The name is deliberately generic. It used to be CHURCH_DATA_DIR /
// MAILROOM_DATA_DIR / ROKOSHIRT_DATA_DIR / GLAAMRG_DATA_DIR / HAPPY_EYEBALLS_DB
// — five names for one concept, which is exactly why the convention could be
// got wrong five separate times. One name means one thing to remember, and
// `site-conformance` can check every site for it.
//
// The cwd fallback exists only for local dev and for scripts that cron runs with
// `cd <repo> &&`, where cwd genuinely is the repo root.
export const DATA_DIR = process.env.SITE_DATA_DIR || join(process.cwd(), "data");

// ---- site-specific paths below this line ----

// The application database. One file; WAL mode adds -wal/-shm siblings beside it.
// data-backup.sh discovers SQLite under ~/code and every declared SITE_DATA_DIR,
// so this file is backed up by existing, not by being remembered.
export const DB_PATH = join(DATA_DIR, "noosphere.sqlite");
