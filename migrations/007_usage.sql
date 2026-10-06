-- 007_usage: private, aggregate usage counts (src/usage.ts, `npm run usage`).
-- No table here holds a client address, a user agent or a contributor id.
-- Additive only: existing tables are untouched.

-- Calls per UTC day. tool: search, get_record, get_revision, list,
-- create_record, propose_revision, report_outcome, annotate, register, connect
-- (an MCP handshake: initialize, tools/list, ...), other.
-- channel: mcp (hosted MCP), web (REST and HTML), house (the site operator's
-- own agents and the server itself), probe (checkers, crawlers, monitors).
-- client: a short normalized label, e.g. "claude-code/1", "curl/8", "other".
CREATE TABLE usage_counts (
  day           TEXT NOT NULL,     -- YYYY-MM-DD, UTC
  tool          TEXT NOT NULL,
  channel       TEXT NOT NULL CHECK (channel IN ('mcp', 'web', 'house', 'probe')),
  client        TEXT NOT NULL,
  status_class  TEXT NOT NULL CHECK (status_class IN ('2xx', '3xx', '4xx', '5xx')),
  count         INTEGER NOT NULL,
  PRIMARY KEY (day, tool, channel, client, status_class)
) WITHOUT ROWID;

-- What was searched for, normalized (trimmed, whitespace collapsed, lowercased,
-- at most 200 characters), or '[withheld]' when it looked like a secret or
-- personal data. Kept 30 days; older rows are deleted at least daily.
CREATE TABLE usage_searches (
  day           TEXT NOT NULL,
  query         TEXT NOT NULL,
  channel       TEXT NOT NULL,
  client        TEXT NOT NULL,
  count         INTEGER NOT NULL,
  result_count  INTEGER NOT NULL,  -- results on the last such search
  zero_results  INTEGER NOT NULL CHECK (zero_results IN (0, 1)),
  PRIMARY KEY (day, query, channel, client)
) WITHOUT ROWID;
CREATE INDEX usage_searches_day ON usage_searches(day);

-- Returning visitors: an HMAC of (address + user-agent family) under a key that
-- changes every month. When it changes, the old month's rows are deleted.
-- days_mask: bit d set = seen on day d+1 of the month.
CREATE TABLE usage_visitors (
  month      TEXT NOT NULL,        -- YYYY-MM
  class      TEXT NOT NULL CHECK (class IN ('outside', 'house', 'probe')),
  hash       TEXT NOT NULL,
  first_day  TEXT NOT NULL,
  days_mask  INTEGER NOT NULL,
  PRIMARY KEY (month, class, hash)
) WITHOUT ROWID;

-- "<YYYY-MM>:<64 hex>"; replaced (with the month's rows) at the first write of a new month.
INSERT INTO settings (key, value)
  VALUES ('usage_visitor_key', strftime('%Y-%m', 'now') || ':' || lower(hex(randomblob(32))));
