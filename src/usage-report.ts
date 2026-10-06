import type { DB } from "./db.ts";
import { isoDay, SEARCH_RETENTION_DAYS, WITHHELD } from "./usage.ts";

// What `npm run usage` prints (and, with --json, returns for the bots
// dashboard and the weekly traffic report). Reads only the usage tables.
// "Outside" is everyone but probes and the site's own agents: channels mcp + web.

const DAY_MS = 86_400_000;
type Cls = "outside" | "house" | "probe";

export interface UsageReport {
  days: string[];
  outside_by_day: { day: string; total: number; tools: Record<string, number> }[];
  outside_by_client: { client: string; channel: string; calls: number }[];
  by_class: { day: string; outside: number; probe: number; house: number }[];
  top_searches: { query: string; searches: number; days: number; last_results: number }[];
  zero_result_searches: { query: string; searches: number; last_day: string }[];
  searches_by_class: { outside: number; probe: number; house: number };
  visitors: {
    note: string;
    by_day: { day: string; outside: number; probe: number; house: number }[];
    by_week: { week_start: string; outside: number; probe: number; house: number }[];
    returning: { outside: number; probe: number; house: number };
  };
}

const classOf = (channel: string): Cls => (channel === "house" ? "house" : channel === "probe" ? "probe" : "outside");

export function usageReport(db: DB, opts: { days?: number; now?: number } = {}): UsageReport {
  const n = Math.max(1, Math.min(opts.days ?? 7, 366));
  const now = opts.now ?? Date.now();
  const days = Array.from({ length: n }, (_, i) => isoDay(now - (n - 1 - i) * DAY_MS));
  const from = days[0]!;
  const to = days.at(-1)!;

  const counts = db
    .prepare("SELECT day, tool, channel, client, status_class, count FROM usage_counts WHERE day BETWEEN ? AND ?")
    .all(from, to) as { day: string; tool: string; channel: string; client: string; status_class: string; count: number }[];

  const outsideByDay = days.map((day) => {
    const tools: Record<string, number> = {};
    let total = 0;
    for (const r of counts) {
      if (r.day !== day || classOf(r.channel) !== "outside") continue;
      tools[r.tool] = (tools[r.tool] ?? 0) + r.count;
      total += r.count;
    }
    return { day, total, tools };
  });

  const clients = new Map<string, { client: string; channel: string; calls: number }>();
  for (const r of counts) {
    if (classOf(r.channel) !== "outside") continue;
    const k = `${r.client}|${r.channel}`;
    const c = clients.get(k) ?? { client: r.client, channel: r.channel, calls: 0 };
    c.calls += r.count;
    clients.set(k, c);
  }

  const byClass = days.map((day) => {
    const row = { day, outside: 0, probe: 0, house: 0 };
    for (const r of counts) if (r.day === day) row[classOf(r.channel)] += r.count;
    return row;
  });

  const searches = db
    .prepare("SELECT day, query, channel, count, result_count, zero_results FROM usage_searches WHERE day BETWEEN ? AND ? ORDER BY day")
    .all(from, to) as { day: string; query: string; channel: string; count: number; result_count: number; zero_results: number }[];
  const searchesByClass = { outside: 0, probe: 0, house: 0 };
  const top = new Map<string, { query: string; searches: number; days: Set<string>; last_results: number }>();
  const zero = new Map<string, { query: string; searches: number; last_day: string }>();
  for (const s of searches) {
    searchesByClass[classOf(s.channel)] += s.count;
    if (classOf(s.channel) !== "outside") continue;
    const t = top.get(s.query) ?? { query: s.query, searches: 0, days: new Set<string>(), last_results: 0 };
    t.searches += s.count;
    t.days.add(s.day);
    t.last_results = s.result_count;
    top.set(s.query, t);
    if (s.zero_results && s.query !== WITHHELD) {
      const z = zero.get(s.query) ?? { query: s.query, searches: 0, last_day: s.day };
      z.searches += s.count;
      z.last_day = s.day;
      zero.set(s.query, z);
    }
  }

  // Visitors: one row per (month, class, hash) with a bitmask of days seen.
  // Only the current month's hashes exist (the key changes monthly).
  const visitorRows = db
    .prepare("SELECT month, class, days_mask FROM usage_visitors WHERE month BETWEEN ? AND ?")
    .all(from.slice(0, 7), to.slice(0, 7)) as { month: string; class: Cls; days_mask: number }[];
  const seenOn = (r: { month: string; days_mask: number }, day: string) =>
    r.month === day.slice(0, 7) && (r.days_mask & (1 << (Number(day.slice(8, 10)) - 1))) !== 0;
  const visitorsByDay = days.map((day) => {
    const row = { day, outside: 0, probe: 0, house: 0 };
    for (const r of visitorRows) if (seenOn(r, day)) row[r.class] += 1;
    return row;
  });
  const weeks: { week_start: string; outside: number; probe: number; house: number }[] = [];
  for (let i = 0; i < days.length; i += 7) {
    const span = days.slice(i, i + 7);
    const row = { week_start: span[0]!, outside: 0, probe: 0, house: 0 };
    for (const r of visitorRows) if (span.some((d) => seenOn(r, d))) row[r.class] += 1;
    weeks.push(row);
  }
  const returning = { outside: 0, probe: 0, house: 0 };
  const popcount = (x: number) => { let c = 0; for (; x; x &= x - 1) c++; return c; };
  for (const r of visitorRows) if (r.month === to.slice(0, 7) && popcount(r.days_mask) >= 2) returning[r.class] += 1;

  return {
    days,
    outside_by_day: outsideByDay,
    outside_by_client: [...clients.values()].sort((a, b) => b.calls - a.calls || a.client.localeCompare(b.client)),
    by_class: byClass,
    top_searches: [...top.values()]
      .sort((a, b) => b.searches - a.searches || a.query.localeCompare(b.query))
      .slice(0, 20)
      .map((t) => ({ query: t.query, searches: t.searches, days: t.days.size, last_results: t.last_results })),
    zero_result_searches: [...zero.values()].sort((a, b) => b.searches - a.searches || a.query.localeCompare(b.query)),
    searches_by_class: searchesByClass,
    visitors: {
      note: `Visitor hashes are kept for the current month only; "returning" means seen on 2+ days of ${to.slice(0, 7)}. ` +
        `Search text is kept ${SEARCH_RETENTION_DAYS} days.`,
      by_day: visitorsByDay,
      by_week: weeks,
      returning,
    },
  };
}

const NOTHING = "  nothing yet";

export function formatUsageReport(r: UsageReport): string {
  const out: string[] = [];
  const section = (title: string, lines: string[]) => {
    out.push(title, ...(lines.length ? lines : [NOTHING]), "");
  };
  out.push(`Noosphere usage, ${r.days[0]} to ${r.days.at(-1)} (UTC). Outside = hosted MCP + web, without probes and house agents.`, "");

  section(
    "Outside calls per day, by tool",
    r.outside_by_day.filter((d) => d.total > 0).map((d) =>
      `  ${d.day}  ${String(d.total).padStart(5)}  ` +
      Object.entries(d.tools).sort((a, b) => b[1] - a[1]).map(([t, c]) => `${t} ${c}`).join(", ")),
  );
  section("Outside calls by client", r.outside_by_client.map((c) => `  ${String(c.calls).padStart(6)}  ${c.client} (${c.channel})`));
  const anyClass = r.by_class.some((d) => d.outside + d.probe + d.house > 0);
  section(
    "Probes vs outside vs house (calls)",
    anyClass
      ? ["  day         outside   probe   house", ...r.by_class.map((d) =>
        `  ${d.day}  ${String(d.outside).padStart(7)} ${String(d.probe).padStart(7)} ${String(d.house).padStart(7)}`)]
      : [],
  );
  const sc = r.searches_by_class;
  section(
    `Top searches (outside${sc.probe + sc.house ? `; not shown: ${sc.probe} by probes, ${sc.house} by house agents` : ""})`,
    r.top_searches.map((s) => `  ${String(s.searches).padStart(5)}  ${JSON.stringify(s.query)}  (${s.days} day${s.days === 1 ? "" : "s"}, last: ${s.last_results} result${s.last_results === 1 ? "" : "s"})`),
  );
  section(
    "Searches that found nothing (outside): candidates for what to write next",
    r.zero_result_searches.map((s) => `  ${String(s.searches).padStart(5)}  ${JSON.stringify(s.query)}  (last ${s.last_day})`),
  );
  const v = r.visitors;
  const anyVisitor = v.by_day.some((d) => d.outside + d.probe + d.house > 0);
  section(
    "Visitors (distinct, by monthly-keyed hash)",
    anyVisitor
      ? [
        "  day         outside   probe   house",
        ...v.by_day.map((d) => `  ${d.day}  ${String(d.outside).padStart(7)} ${String(d.probe).padStart(7)} ${String(d.house).padStart(7)}`),
        ...v.by_week.map((w) => `  week of ${w.week_start}: outside ${w.outside}, probe ${w.probe}, house ${w.house}`),
        `  came back on 2+ days this month: outside ${v.returning.outside}, probe ${v.returning.probe}, house ${v.returning.house}`,
        `  ${v.note}`,
      ]
      : [],
  );
  return out.join("\n");
}
