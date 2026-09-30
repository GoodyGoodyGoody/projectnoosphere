import type { DB } from "../db.ts";
import { getRevisionSummaries } from "./records.ts";

// Keyword search over the current published revision of each record; open
// candidates only when asked for explicitly. Results are summaries — never
// bodies — so a visiting agent's context isn't flooded; each carries its exact
// revision id and links to the full content.

// User text never reaches FTS5 query syntax: it is reduced to letter/number
// tokens, each quoted. `"AND OR NEAR(` and friends become plain words.
export function toTokens(q: string): string[] {
  const tokens = q.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(tokens)].slice(0, 12);
}

export interface SearchOptions {
  limit: number;
  offset: number;
  includeCandidate: boolean;
}

export function search(db: DB, q: string, opts: SearchOptions) {
  const tokens = toTokens(q);
  const visibilities = opts.includeCandidate ? ["published", "candidate"] : ["published"];
  const empty = { match: "all" as const, items: [], next_offset: null };
  if (!tokens.length) return { query: q, tokens, included: visibilities, ...empty };

  const run = (expr: string) =>
    db
      .prepare(
        `SELECT v.id, s.visibility, bm25(revision_search, 0.0, 10.0, 5.0, 1.0, 3.0) AS score
           FROM revision_search s
           JOIN revisions v ON v.rowid = s.rowid
           JOIN revision_review rr ON rr.revision_id = v.id
           JOIN records r ON r.id = v.record_id
          WHERE revision_search MATCH ?
            AND s.visibility IN (SELECT value FROM json_each(?))
            -- Re-checked at read time: the index is a cache, state is the truth.
            AND ((rr.state = 'reviewed' AND r.current_revision_id = v.id)
                 OR (rr.state = 'candidate' AND ?))
          ORDER BY score, v.id
          LIMIT ? OFFSET ?`,
      )
      .all(expr, JSON.stringify(visibilities), opts.includeCandidate ? 1 : 0, opts.limit + 1, opts.offset) as {
      id: string;
    }[];

  // Every word first; if that finds nothing, any word — ranked, so the best
  // partial matches lead. Natural-language agent queries rarely match on all.
  const quoted = tokens.map((t) => `"${t}"`);
  let match: "all" | "any" = "all";
  let rows = run(quoted.join(" "));
  if (!rows.length && tokens.length > 1) {
    match = "any";
    rows = run(quoted.join(" OR "));
  }
  const more = rows.length > opts.limit;
  const ids = rows.slice(0, opts.limit).map((r) => r.id);
  const items = getRevisionSummaries(db, ids).filter((s) => !("withheld" in s));
  return {
    query: q,
    tokens,
    included: visibilities,
    match,
    items,
    next_offset: more ? opts.offset + opts.limit : null,
  };
}
