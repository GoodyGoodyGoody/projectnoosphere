// One clock for the application: ISO-8601 UTC with milliseconds. Timestamps are
// generated here rather than by SQLite so they can be part of content hashes.
export function nowIso(date: Date = new Date()): string {
  return date.toISOString();
}
