-- 003_registration_and_limits: self-serve registration and persistent limits.

-- Who created a contributor, under which terms, and a keyed hash of the
-- registering address (never the raw IP) for linked-account signals.
ALTER TABLE contributors ADD COLUMN created_via TEXT NOT NULL DEFAULT 'cli'
  CHECK (created_via IN ('cli', 'registration'));
ALTER TABLE contributors ADD COLUMN terms_version TEXT;
ALTER TABLE contributors ADD COLUMN registration_ip_hash TEXT;

-- Server-generated settings shared by every process that opens this database.
CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
-- Key for hashing client addresses. Generated once, here, so all PM2 workers
-- agree without any configuration; lives and dies with the database.
INSERT INTO settings (key, value) VALUES ('ip_hash_key', lower(hex(randomblob(32))));

-- Fixed-window counters. In the database, not in memory: limits survive a
-- restart and are shared by every worker process.
CREATE TABLE rate_limits (
  bucket        TEXT NOT NULL,
  window_start  INTEGER NOT NULL,  -- unix seconds, aligned to the window size
  count         INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
) WITHOUT ROWID;
CREATE INDEX rate_limits_window ON rate_limits(window_start);
