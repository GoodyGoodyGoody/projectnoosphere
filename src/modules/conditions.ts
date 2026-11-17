// Outcome reports grouped by the conditions they ran under.
//
// Reports that differ by conditions are not disagreements: "worked on node 24"
// and "failed on node 26" can both be true. Reports are weighed only inside one
// cell: the same revision, and materially the same values for the conditions
// the revision itself names. A failure that carries a check, met by "worked"
// reports in the same cell, marks the cell DISPUTED. That is a flag shown to the
// reader; it never hides, removes or quarantines anything.
//
// Pure functions over already-read reports. Callers read reports through the
// view functions; nothing here touches the database.

// Condition keys that describe a report or a revision rather than the
// environment it applies to. Never used to group reports. The one shared list.
export const DESCRIPTIVE_CONDITION_KEYS: readonly string[] = [
  "date",
  "observed",
  "observed_via",
  "limitations",
  "notes",
  "window",
  "items",
];

const canonicalKey = (k: string) => k.trim().toLowerCase();
const DESCRIPTIVE = new Set(DESCRIPTIVE_CONDITION_KEYS.map(canonicalKey));

export const NOT_STATED = "not stated";

// "Ubuntu 24.04.1" and "ubuntu-24.04" are the same condition; so are "v24.19.0"
// and "24.19.3". Versions are cut to their first two parts.
export function normalizeConditionValue(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return s
    .toLowerCase()
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(^|[^a-z0-9])v(?=\d)/g, "$1")
    .replace(/\b(\d+\.\d+)(?:\.\d+)+\b/g, "$1");
}

// The environment keys a revision names, in the revision's order.
export function environmentKeys(conditions: Record<string, unknown>): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const k of Object.keys(conditions)) {
    const c = canonicalKey(k);
    if (DESCRIPTIVE.has(c) || seen.has(c)) continue;
    seen.add(c);
    keys.push(k);
  }
  return keys;
}

export interface CellReport {
  report_id: string;
  author_id: string;
  outcome: string;
  checked: boolean;
  conditions: Record<string, unknown>;
  created_at: string;
}

export type CellVerdict = "worked" | "failed" | "partially_worked" | "not_applicable" | "inconclusive" | "disputed" | "mixed";

export interface ConditionCell {
  // Each grouping key with the original wording of the cell's first report,
  // or null where that report did not state it.
  conditions: Record<string, string | null>;
  label: string;
  verdict: CellVerdict;
  reports: number;
  with_check: number;
  outcomes: Record<string, number>;
  outcomes_with_check: Record<string, number>;
  contributors: number;
  latest_at: string;
  report_ids: string[];
}

export interface ByConditions {
  grouped_by: string[];
  cells: ConditionCell[];
  notice: string;
}

export const BY_CONDITIONS_NOTICE =
  "Reports are grouped by the values they give for the revision's own conditions. Reports under different conditions are not disagreements. A cell is disputed when a failed report that carries a check meets worked or partially worked reports under the same conditions; the reports are all still shown. Conditions with no cell were not reported.";

function lookup(conditions: Record<string, unknown>, key: string): { found: boolean; value: unknown } {
  const want = canonicalKey(key);
  for (const [k, v] of Object.entries(conditions)) {
    if (canonicalKey(k) === want) return { found: true, value: v };
  }
  return { found: false, value: undefined };
}

export function cellVerdict(reports: Pick<CellReport, "outcome" | "checked">[]): CellVerdict {
  const outcomes = new Set(reports.map((r) => r.outcome));
  const checkedFailure = reports.some((r) => r.outcome === "failed" && r.checked);
  const success = reports.some((r) => r.outcome === "worked" || r.outcome === "partially_worked");
  if (checkedFailure && success) return "disputed";
  if (outcomes.size === 1) return [...outcomes][0] as CellVerdict;
  return "mixed";
}

const display = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v) ?? String(v));

// Group a revision's reviewed outcome reports into cells. revisionConditions
// are the revision's own conditions; only its environment keys group reports.
// With none, the reports' own `os` key groups them if any report states it;
// otherwise all reports share one cell.
export function groupByConditions(revisionConditions: Record<string, unknown>, reports: CellReport[]): ByConditions {
  let keys = environmentKeys(revisionConditions);
  if (!keys.length && reports.some((r) => lookup(r.conditions, "os").found)) keys = ["os"];

  const ordered = [...reports].sort((a, b) =>
    a.created_at === b.created_at ? (a.report_id < b.report_id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1,
  );
  const groups = new Map<string, CellReport[]>();
  for (const r of ordered) {
    const id = JSON.stringify(keys.map((k) => {
      const { found, value } = lookup(r.conditions, k);
      return found ? normalizeConditionValue(value) : null;
    }));
    groups.set(id, [...(groups.get(id) ?? []), r]);
  }

  const cells = [...groups.values()].map((rs): ConditionCell => {
    const first = rs[0]!;
    const conditions: Record<string, string | null> = {};
    for (const k of keys) {
      const { found, value } = lookup(first.conditions, k);
      conditions[k] = found ? display(value) : null;
    }
    const outcomes: Record<string, number> = {};
    const outcomesWithCheck: Record<string, number> = {};
    for (const r of rs) {
      outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
      if (r.checked) outcomesWithCheck[r.outcome] = (outcomesWithCheck[r.outcome] ?? 0) + 1;
    }
    return {
      conditions,
      label: keys.length
        ? keys.map((k) => `${k} ${conditions[k] ?? NOT_STATED}`).join(" · ")
        : "all reports (the revision names no conditions to group by)",
      verdict: cellVerdict(rs),
      reports: rs.length,
      with_check: rs.filter((r) => r.checked).length,
      outcomes,
      outcomes_with_check: outcomesWithCheck,
      contributors: new Set(rs.map((r) => r.author_id)).size,
      latest_at: rs.reduce((m, r) => (r.created_at > m ? r.created_at : m), first.created_at),
      report_ids: rs.map((r) => r.report_id),
    };
  });
  // Disputed cells first, then the best-attested, then by label.
  cells.sort((a, b) =>
    Number(b.verdict === "disputed") - Number(a.verdict === "disputed") ||
    b.reports - a.reports ||
    (a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
  );
  return { grouped_by: keys, cells, notice: BY_CONDITIONS_NOTICE };
}
