# 0001 — SQLite instead of PostgreSQL for v0.1

- **Status:** accepted, 2026-09-30. Randall chose it after being shown the options.
- **Context:** The handoff recommends PostgreSQL for transactions, relational integrity,
  JSON, and full-text search. The droplet had no Postgres. Installing one (by apt or Docker)
  needs sudo, which agents can't do here. It would also have been the box's first Postgres,
  which means a new pg_dump backup family, a selftest case, a restore drill, a reboot note,
  and one more daemon on a shared 8 GB host. Every other data site on the droplet uses SQLite
  through better-sqlite3. `data-backup.sh` already *discovers* SQLite under `~/code` and every
  declared SITE_DATA_DIR, and a restore drill already exists.

## Decision
Use SQLite 3.53 (bundled with better-sqlite3 13) with these settings:
- WAL journal mode, `foreign_keys=ON`, `busy_timeout=5000`, `synchronous=NORMAL`.
- Writes use IMMEDIATE transactions, so concurrent writers serialize instead of deadlocking.
- FTS5 provides search (Phase 2). JSON1 with `json_valid`/`json_type` CHECKs covers the
  structured fields.

## How each handoff requirement is met

| Requirement | Mechanism |
| --- | --- |
| Transactions, constraints | IMMEDIATE transactions, FK + CHECK constraints |
| Immutable revisions and annotations | `BEFORE UPDATE/DELETE` triggers that `RAISE(ABORT)` |
| Atomic publish (compare-and-set) | `UPDATE … WHERE current_revision_id IS ?` in one transaction |
| Full-text search | FTS5 external-content table over the current reviewed revision (Phase 2) |
| JSON metadata | TEXT + `json_valid` CHECKs; `json_each` in queries |
| Concurrency | WAL allows many readers and one writer; the write volume is small and moderated |
| Least-privilege DB user | *Not available.* Mitigated: the DB file is owned by the app user and the directory is mode 700; there is no network listener at all |

## Consequences
- No new daemon, no sudo, nothing new to back up, and the house restore drill applies.
- Lost versus Postgres: database roles and grants, `tsvector` ranking (FTS5's bm25 is
  comparable), and multi-host writes.
- **Revisit when** any of these happen:
  - federation or a second writer host appears;
  - SQLite write contention is measured in production;
  - semantic retrieval needs something `sqlite-vec` can't provide.

  The migration path is the schema-versioned export, plus a port of the numbered migrations.
  Keep SQL portable where it costs nothing.
