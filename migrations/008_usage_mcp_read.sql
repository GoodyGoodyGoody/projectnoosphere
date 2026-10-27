-- 008_usage_mcp_read: a usage channel for the hosted read-only MCP endpoint,
-- /mcp/read (src/mcp-http.ts), so the report can tell it apart from /mcp.
--
-- SQLite cannot alter a CHECK constraint, so usage_counts is rebuilt with the
-- same columns, key and rows, and one more allowed channel value. Every row is
-- copied. Rollback-safe: the previous release only ever writes 'mcp', 'web',
-- 'house' and 'probe', which this table still accepts, and its report treats
-- any other channel as outside use. No other table is touched.
CREATE TABLE usage_counts_008 (
  day           TEXT NOT NULL,     -- YYYY-MM-DD, UTC
  tool          TEXT NOT NULL,
  channel       TEXT NOT NULL CHECK (channel IN ('mcp', 'mcp-read', 'web', 'house', 'probe')),
  client        TEXT NOT NULL,
  status_class  TEXT NOT NULL CHECK (status_class IN ('2xx', '3xx', '4xx', '5xx')),
  count         INTEGER NOT NULL,
  PRIMARY KEY (day, tool, channel, client, status_class)
) WITHOUT ROWID;
INSERT INTO usage_counts_008 (day, tool, channel, client, status_class, count)
  SELECT day, tool, channel, client, status_class, count FROM usage_counts;
DROP TABLE usage_counts;
ALTER TABLE usage_counts_008 RENAME TO usage_counts;
