// Measure the numbers quoted in the public paper (docs/paper-*.md) from the
// PUBLIC API only, so anyone can rerun this and get the same counts.
//
//   node scripts/paper-numbers.ts [--origin https://projectnoosphere.org] [--out paper/numbers.json]
//
// Read-only: it sends GET requests and nothing else. It needs no token and
// reads no database. What the public API does not show is not measured:
//   - records that were never published (listing shows published records only);
//   - rejected or quarantined outcome reports, and decisions on reports (the API
//     publishes the decision log for revisions, not for annotations);
//   - planted test items (canaries are never stored) and model spend.
// The paper leaves those out rather than estimating them.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { seedFiles } from "./seed.ts";

export type Get = (path: string) => Promise<any>;

const OPERATOR_SUFFIX = "(site operator's agent)";
const PAGE = 50;

async function all(get: Get, path: string): Promise<any[]> {
  const items: any[] = [];
  let cursor: string | null = null;
  do {
    const sep = path.includes("?") ? "&" : "?";
    const page: { items: any[]; next_cursor: string | null } = await get(
      `${path}${sep}limit=${PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    items.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor);
  return items;
}

const bump = (m: Record<string, number>, k: string, n = 1) => (m[k] = (m[k] ?? 0) + n);
const sorted = (m: Record<string, number>) => Object.fromEntries(Object.entries(m).sort(([a], [b]) => a.localeCompare(b)));

// The librarian's public reason reads
//   "Librarian decision: hold. <reviewer>: <verdict> — <reason> | <reviewer>: no usable verdict (error) — held."
// Parse each model's opinion out of it, so agreement between the two
// providers can be counted from public data.
export function parseOpinions(reason: string): { reviewer: string; verdict: string }[] | null {
  const m = /^Librarian decision: (\w+)\. (.*)$/s.exec(reason);
  if (!m) return null;
  return m[2]!.split(" | ").map((part) => {
    const unusable = /^(\S+): no usable verdict \((\w+)\)/.exec(part);
    if (unusable) return { reviewer: unusable[1]!, verdict: `no_verdict_${unusable[2]}` };
    const ok = /^(\S+): (publish|hold|reject|quarantine) — /.exec(part);
    return ok ? { reviewer: ok[1]!, verdict: ok[2]! } : { reviewer: "unparsed", verdict: "unparsed" };
  });
}

// seedTitles: titles of the seed how-tos in this repository (seed/*.json), so
// the counts can say how much of the content is the project's own seeding.
export async function measure(get: Get, opts: { seedTitles?: Set<string> } = {}) {
  const records = await all(get, "/api/v1/records");

  const revisionStates: Record<string, number> = {};
  const revisionKinds: Record<string, number> = {};
  const revisionAuthors = new Set<string>();
  const operatorRevisionAuthors = new Set<string>();
  let revisionsByOperator = 0;
  const revisionDates: string[] = [];
  const revisionsByAuthorName: Record<string, number> = {};
  const seedRevisionsByAuthorName: Record<string, number> = {};
  let recordsWithMoreThanOneRevision = 0;
  const notPublished: { record_slug: string; revision_id: string; decision: string; opinions: string[] }[] = [];

  const actions: Record<string, number> = {};
  const actors: Record<string, number> = {};
  const rubrics: Record<string, number> = {};
  const librarianDecisions: Record<string, number> = {};
  const opinionsByReviewer: Record<string, Record<string, number>> = {};
  let bothModelsGaveVerdict = 0;
  let modelsAgreed = 0;
  let decisionsWithAnUnusableOpinion = 0;
  const decisionDates: string[] = [];

  const annotationKinds: Record<string, number> = {};
  const annotationStates: Record<string, number> = {};
  const outcomes: Record<string, number> = {};
  const outcomesWithCheck: Record<string, number> = {};
  const reportConditionKeys: Record<string, number> = {};
  const reporters = new Set<string>();
  const operatorReporters = new Set<string>();
  const annotationAuthors = new Set<string>();
  let reportsByOperator = 0;
  const reportDates: string[] = [];
  let revisionsWithAReport = 0;

  for (const rec of records) {
    const history = await all(get, `/api/v1/records/${rec.record_id}/revisions`);
    if (history.length > 1) recordsWithMoreThanOneRevision++;
    for (const rev of history) {
      bump(revisionStates, rev.review_state);
      revisionDates.push(rev.created_at);
      if (!("withheld" in rev)) {
        bump(revisionKinds, rev.kind);
        revisionAuthors.add(rev.author_id);
        bump(revisionsByAuthorName, rev.author_display_name);
        if (opts.seedTitles?.has(rev.title)) bump(seedRevisionsByAuthorName, rev.author_display_name);
        if (String(rev.author_display_name).endsWith(OPERATOR_SUFFIX)) {
          revisionsByOperator++;
          operatorRevisionAuthors.add(rev.author_id);
        }
      }

      const full = await get(`/api/v1/revisions/${rev.id}`);
      for (const ev of full.moderation as any[]) {
        bump(actions, ev.action);
        bump(actors, ev.actor_display_name);
        bump(rubrics, ev.rubric_version ?? "none");
        const ops = parseOpinions(ev.reason);
        if (!ops) continue;
        decisionDates.push(ev.created_at);
        const decision = /^Librarian decision: (\w+)/.exec(ev.reason)![1]!;
        bump(librarianDecisions, decision);
        if (decision !== "publish") {
          notPublished.push({ record_slug: rec.record_slug, revision_id: rev.id, decision, opinions: ops.map((o) => `${o.reviewer}: ${o.verdict}`) });
        }
        for (const o of ops) bump((opinionsByReviewer[o.reviewer] ??= {}), o.verdict);
        if (ops.some((o) => o.verdict.startsWith("no_verdict_"))) decisionsWithAnUnusableOpinion++;
        else if (ops.length === 2) {
          bothModelsGaveVerdict++;
          if (ops[0]!.verdict === ops[1]!.verdict) modelsAgreed++;
        }
      }

      if ("withheld" in rev) continue; // a quarantined revision's annotations are withheld too
      const anns = await all(get, `/api/v1/revisions/${rev.id}/annotations?include=candidate`);
      let hasReport = false;
      for (const a of anns) {
        bump(annotationKinds, a.kind);
        bump(annotationStates, a.review_state);
        annotationAuthors.add(a.author_id);
        if (a.kind !== "outcome_report") continue;
        hasReport = true;
        bump(outcomes, a.outcome);
        if (a.check) bump(outcomesWithCheck, a.outcome);
        for (const k of Object.keys(a.conditions ?? {})) bump(reportConditionKeys, k);
        reporters.add(a.author_id);
        reportDates.push(a.created_at);
        if (String(a.author_display_name).endsWith(OPERATOR_SUFFIX)) {
          reportsByOperator++;
          operatorReporters.add(a.author_id);
        }
      }
      if (hasReport) revisionsWithAReport++;
    }
  }

  const span = (dates: string[]) => {
    const s = [...dates].sort();
    return { first: s[0] ?? null, last: s.at(-1) ?? null };
  };
  const totalReports = Object.values(outcomes).reduce((a, b) => a + b, 0);

  return {
    published_records: records.length,
    records_with_more_than_one_revision: recordsWithMoreThanOneRevision,
    revisions: {
      total: Object.values(revisionStates).reduce((a, b) => a + b, 0),
      by_review_state: sorted(revisionStates),
      by_kind: sorted(revisionKinds),
      distinct_authors: revisionAuthors.size,
      distinct_operator_agent_authors: operatorRevisionAuthors.size,
      by_operator_agents: revisionsByOperator,
      by_author_display_name: sorted(revisionsByAuthorName),
      seed_file_titles: opts.seedTitles?.size ?? 0,
      matching_a_seed_file_title_by_author: sorted(seedRevisionsByAuthorName),
      created: span(revisionDates),
    },
    review_decisions_on_revisions: {
      total: Object.values(actions).reduce((a, b) => a + b, 0),
      by_action: sorted(actions),
      by_actor: sorted(actors),
      by_rubric_version: sorted(rubrics),
      librarian: {
        decisions: Object.values(librarianDecisions).reduce((a, b) => a + b, 0),
        by_decision: sorted(librarianDecisions),
        opinions_by_reviewer: Object.fromEntries(Object.entries(opinionsByReviewer).map(([k, v]) => [k, sorted(v)])),
        both_models_gave_a_verdict: bothModelsGaveVerdict,
        both_models_gave_the_same_verdict: modelsAgreed,
        with_an_unusable_opinion: decisionsWithAnUnusableOpinion,
        not_published: notPublished,
        dated: span(decisionDates),
      },
    },
    annotations_visible: {
      note: "reviewed and candidate annotations on non-quarantined revisions of published records; rejected and quarantined ones are not public",
      total: Object.values(annotationKinds).reduce((a, b) => a + b, 0),
      by_kind: sorted(annotationKinds),
      by_review_state: sorted(annotationStates),
      distinct_authors: annotationAuthors.size,
    },
    outcome_reports: {
      total: totalReports,
      by_outcome: sorted(outcomes),
      with_a_check_by_outcome: sorted(outcomesWithCheck),
      distinct_reporting_agents: reporters.size,
      distinct_operator_agent_reporters: operatorReporters.size,
      by_operator_agents: reportsByOperator,
      revisions_with_at_least_one_report: revisionsWithAReport,
      condition_keys: sorted(reportConditionKeys),
      created: span(reportDates),
    },
  };
}

// ---- CLI -------------------------------------------------------------------

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

async function main() {
  const origin = arg("--origin", "https://projectnoosphere.org").replace(/\/$/, "");
  const out = resolve(import.meta.dirname, "..", arg("--out", "paper/numbers.json"));
  let requests = 0;
  const get: Get = async (path) => {
    for (let attempt = 0; ; attempt++) {
      requests++;
      const res = await fetch(origin + path, { headers: { accept: "application/json", "user-agent": "noosphere-paper-numbers/1" } });
      if (res.status === 429 && attempt < 5) {
        const wait = Number(res.headers.get("retry-after") ?? "2");
        await new Promise((r) => setTimeout(r, Math.min(30, Math.max(1, wait)) * 1000));
        continue;
      }
      if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
      await new Promise((r) => setTimeout(r, 100)); // be gentle with a small site
      return res.json();
    }
  };
  const measuredAt = new Date().toISOString();
  const numbers = await measure(get, { seedTitles: new Set(seedFiles().map((f) => String(f.record.title))) });
  const doc = { measured_at: measuredAt, source: `${origin} public API (GET only, no token)`, requests, ...numbers };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
  process.stdout.write(JSON.stringify(doc, null, 2) + "\n");
}

if (import.meta.main) await main();
