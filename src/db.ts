import Database from "better-sqlite3";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { nowIso } from "./time.ts";

export type DB = Database.Database;

// Resolved from this module, never from cwd: migrations ship with the code.
const MIGRATIONS_DIR = join(import.meta.dirname, "..", "migrations");

export function openDb(path: string): DB {
  // 0700: the database file is the only access control SQLite has (ADR 0001).
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

interface Migration {
  version: number;
  name: string;
  sql: string;
}

function listMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((f) => ({
      version: Number(f.slice(0, 3)),
      name: f.replace(/\.sql$/, ""),
      sql: readFileSync(join(dir, f), "utf8"),
    }));
}

function ensureMigrationTable(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
}

// The migrations a piece of code was shipped with. Take this ONCE, when a
// process starts: it is what that process's code needs, and it must not change
// when a newer release's files are checked out underneath a running worker.
export function migrationNames(dir: string = MIGRATIONS_DIR): string[] {
  return listMigrations(dir).map((m) => m.name);
}

export function pendingMigrations(db: DB, expected: string[] = migrationNames()): string[] {
  ensureMigrationTable(db);
  const applied = new Set(
    db.prepare("SELECT name FROM schema_migrations").pluck().all() as string[],
  );
  return expected.filter((name) => !applied.has(name));
}

// Applies each pending migration in its own IMMEDIATE transaction, so two
// processes starting together serialize instead of both applying one file.
export function migrate(db: DB): string[] {
  ensureMigrationTable(db);
  const done: string[] = [];
  for (const m of listMigrations()) {
    const apply = db.transaction(() => {
      const already = db
        .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
        .get(m.version);
      if (already) return false;
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
        .run(m.version, m.name, nowIso());
      return true;
    });
    if (apply.immediate()) done.push(m.name);
  }
  return done;
}

export function schemaVersion(db: DB): number {
  ensureMigrationTable(db);
  const v = db.prepare("SELECT max(version) FROM schema_migrations").pluck().get();
  return typeof v === "number" ? v : 0;
}
