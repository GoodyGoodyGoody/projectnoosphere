import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pickCanaries, type Canary } from "./canaries.ts";
import type { NoosphereClient } from "./client.ts";
import { buildUserMessage, SYSTEM_PROMPT } from "./prompt.ts";
import type { Reviewer, ReviewInput, ReviewResult } from "./reviewer.ts";
import type { SpendLedger } from "./spend.ts";
import { combine, publicReason, type Opinion, type VerdictValue } from "./verdict.ts";

// One "sleep" cycle of the librarian (ADR 0005, ROADMAP G3–G5):
//
//   1. Paused? Do nothing.
//   2. Read the review queue (items not yet decided under this rubric).
//   3. Review the planted canaries FIRST, then real items — one item per call,
//      both models, stopping when the per-run or monthly budget would be crossed.
//   4. Check the canaries. If any known-bad one would be published: apply
//      NOTHING, pause, alarm. The whole run is untrusted.
//   5. Only then apply: supersede stale-base losers (by code, no model), then
//      each item's combined decision — idempotently, so a crash and rerun never
//      double-apply.

export interface CycleOptions {
  client: NoosphereClient;
  primary: Reviewer;
  second: Reviewer;
  rubricVersion: string;
  ledger: SpendLedger;
  monthlyCapUsd: number;
  runCapUsd: number;
  pauseFile: string;
  notify: (subject: string, body: string) => void;
  now?: () => Date;
  canaries?: Canary[];
  limit?: number;
  // Called for each successfully applied decision. revisionId is the revision
  // the item belongs to (itself, or an annotation's target), so the caller can
  // tell search engines which record page changed (IndexNow, scripts/librarian.ts).
  onApplied?: (action: string, targetId: string, revisionId: string) => void;
  // Called once per model call (the CLI reports to the bots dashboard).
  onUsage?: (reviewer: string, inputTokens: number, outputTokens: number) => void | Promise<void>;
}

interface WorkItem {
  kind: "revision" | "annotation";
  targetId: string;
  revisionId: string;
  payload: Record<string, unknown>;
  canary?: Canary;
}

interface Decided extends WorkItem {
  decision: VerdictValue;
  opinions: Opinion[];
}

export interface CycleReport {
  paused?: string;
  reviewed: number;
  superseded: number;
  applied: Record<string, number>;
  applyErrors: string[];
  stoppedByBudget: boolean;
  // The MONTHLY cap stopped this run (a per-run stop just continues tomorrow).
  monthlyCapReached: boolean;
  // The queue came back at its limit, so more may be waiting (runNight loops on it).
  queueFull: boolean;
  unverified: boolean;
  canaries: { name: string; expect: string; decision: VerdictValue }[];
  canaryFailure: boolean;
  spendRunUsd: number;
  spendMonthUsd: number;
}

const ACTIONS: Record<"revision" | "annotation", Record<VerdictValue, string>> = {
  revision: { publish: "publish_revision", reject: "reject_revision", quarantine: "quarantine_revision", hold: "hold_revision" },
  annotation: { publish: "approve_annotation", reject: "reject_annotation", quarantine: "quarantine_annotation", hold: "hold_annotation" },
};

// What the models see about a revision: its content and context, as data.
function revisionPayload(i: { revision: any; gate_flags: unknown[]; current_published: any }) {
  const r = i.revision;
  return {
    id: r.id, kind: r.kind, title: r.title, summary: r.summary, body_markdown: r.body_markdown,
    tags: r.tags, sources: r.sources, conditions: r.conditions, links: r.links,
    author_display_name: r.author_display_name, gate_flags: i.gate_flags,
    is_edit_of_published_record: r.base_revision_id !== null,
    current_published: i.current_published ? { title: i.current_published.title, summary: i.current_published.summary } : null,
  };
}

function annotationPayload(i: { annotation: any; gate_flags: unknown[]; target_revision: any }) {
  const a = i.annotation;
  return {
    id: a.id, kind: a.kind, outcome: a.outcome, body: a.body, check: a.check, evidence: a.evidence, conditions: a.conditions,
    author_display_name: a.author_display_name, gate_flags: i.gate_flags,
    target_revision: i.target_revision ? { title: i.target_revision.title, summary: i.target_revision.summary, review_state: i.target_revision.review_state } : null,
  };
}

async function safeReview(reviewer: Reviewer, input: ReviewInput): Promise<ReviewResult> {
  try {
    return await reviewer.review(input);
  } catch (err) {
    return {
      reviewer: reviewer.id, status: "error", verdict: null,
      usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0,
    };
  }
}

export async function runCycle(o: CycleOptions): Promise<CycleReport> {
  const now = o.now?.() ?? new Date();
  const month = now.toISOString().slice(0, 7);
  const report: CycleReport = {
    reviewed: 0, superseded: 0, applied: {}, applyErrors: [], stoppedByBudget: false, monthlyCapReached: false, queueFull: false, unverified: false,
    canaries: [], canaryFailure: false, spendRunUsd: 0, spendMonthUsd: o.ledger.monthTotal(month),
  };

  if (existsSync(o.pauseFile)) {
    report.paused = readFileSync(o.pauseFile, "utf8").trim() || "paused";
    return report;
  }

  const limit = o.limit ?? 50;
  const queue = await o.client.queue(o.rubricVersion, limit);
  report.queueFull = queue.revisions.length >= limit || queue.annotations.length >= limit;
  const stale = queue.revisions.filter((i) => i.base_is_stale).map((i) => i.revision.id as string);
  const canaries = o.canaries ?? pickCanaries(now.toISOString());
  const work: WorkItem[] = [
    // Canaries first, so a budget stop can never leave a run unverified by chance.
    ...canaries.map((c) => ({ kind: c.kind, targetId: String(c.payload.id), revisionId: "", payload: c.payload, canary: c })),
    ...queue.revisions.filter((i) => !i.base_is_stale).map((i) => ({ kind: "revision" as const, targetId: i.revision.id, revisionId: i.revision.id, payload: revisionPayload(i) })),
    ...queue.annotations.map((i) => ({ kind: "annotation" as const, targetId: i.annotation.id, revisionId: i.annotation.revision_id, payload: annotationPayload(i) })),
  ];

  const decided: Decided[] = [];
  for (const item of work) {
    const input: ReviewInput = { kind: item.kind, system: SYSTEM_PROMPT, user: buildUserMessage(item.kind, item.payload) };
    const worst = o.primary.maxCostUsd(input) + o.second.maxCostUsd(input);
    const overMonth = report.spendMonthUsd + report.spendRunUsd + worst > o.monthlyCapUsd;
    if (overMonth || report.spendRunUsd + worst > o.runCapUsd) {
      report.stoppedByBudget = true;
      report.monthlyCapReached = overMonth;
      break;
    }
    const opinions = await Promise.all([safeReview(o.primary, input), safeReview(o.second, input)]);
    for (const op of opinions) {
      report.spendRunUsd += op.costUsd;
      await o.onUsage?.(op.reviewer, op.usage.inputTokens + (op.usage.cacheReadTokens ?? 0) + (op.usage.cacheWriteTokens ?? 0), op.usage.outputTokens);
      o.ledger.append({
        at: new Date().toISOString(), month, reviewer: op.reviewer, target: item.canary ? `canary:${item.canary.name}` : item.targetId,
        inputTokens: op.usage.inputTokens, outputTokens: op.usage.outputTokens, costUsd: op.costUsd,
      });
    }
    decided.push({ ...item, decision: combine(opinions[0]!, opinions[1]!), opinions });
  }
  report.spendMonthUsd += report.spendRunUsd;

  // A per-run stop is routine: the rest waits for tomorrow night. The monthly
  // cap is different — nothing is reviewed until the 1st, silently, unless we
  // say so. It is Randall's budget, so it is his question. Once per month (a
  // marker beside the pause file), not every night until the 1st.
  if (report.monthlyCapReached) {
    const marker = join(dirname(o.pauseFile), `librarian-budget-alarm-${month}`);
    if (!existsSync(marker)) {
      writeFileSync(marker, `${now.toISOString()}\n`, { mode: 0o600 });
      o.notify(
        `Noosphere librarian: the ${month} review budget is used up`,
        `The librarian has spent $${report.spendMonthUsd.toFixed(2)} of its $${o.monthlyCapUsd} monthly cap, so it has stopped reviewing until the 1st.\n` +
          `New submissions wait as unreviewed candidates until then (visible by direct link, labeled, not indexed).\n\n` +
          `Your choice: do nothing and it resumes on the 1st, or ask an agent to raise LIBRARIAN_MONTHLY_CAP_USD in the production .env.\n` +
          `This email is sent once per month.`,
      );
    }
  }

  // ---- the canary check, before anything is applied ----
  const canaryResults = decided.filter((d) => d.canary);
  report.canaries = canaryResults.map((d) => ({ name: d.canary!.name, expect: d.canary!.expect, decision: d.decision }));
  report.canaryFailure = canaryResults.some((d) => d.canary!.expect === "not_publish" && d.decision === "publish");
  if (canaryResults.length < canaries.length) report.unverified = true;

  if (report.canaryFailure) {
    const failed = report.canaries.filter((c) => c.expect === "not_publish" && c.decision === "publish").map((c) => c.name);
    writeFileSync(o.pauseFile, `paused ${now.toISOString()}: canary published (${failed.join(", ")}); run discarded\n`, { mode: 0o600 });
    o.notify(
      "Noosphere librarian PAUSED: a planted bad submission would have been published",
      `The librarian's run on ${now.toISOString()} would have published a known-bad test item (${failed.join(", ")}).\n` +
        `Nothing from that run was applied, and automatic publication is paused until someone investigates.\n` +
        `Ask an agent to look at the librarian logs. Resume with: npm run librarian -- resume`,
    );
    return report;
  }
  if (report.unverified) return report; // canaries didn't all run (budget): apply nothing, try next cycle

  // ---- apply, idempotently ----
  const tally = (action: string) => (report.applied[action] = (report.applied[action] ?? 0) + 1);
  for (const id of stale) {
    const res = await o.client.moderate(
      "supersede_revision", id,
      "Superseded automatically: its base revision is no longer the record's current version. Re-propose against the current revision.",
      o.rubricVersion,
    );
    if (res.status === 201) report.superseded++;
    else report.applyErrors.push(`${id} supersede: HTTP ${res.status} ${res.body?.error?.code ?? ""}`);
  }
  for (const d of decided) {
    if (d.canary) continue;
    report.reviewed++;
    const action = ACTIONS[d.kind][d.decision];
    const res = await o.client.moderate(action, d.targetId, publicReason(d.decision, d.opinions), o.rubricVersion);
    if (res.status === 201) {
      tally(action);
      o.onApplied?.(action, d.targetId, d.revisionId);
    } else report.applyErrors.push(`${d.targetId} ${action}: HTTP ${res.status} ${res.body?.error?.code ?? ""}`);
  }
  return report;
}

// ---- a whole night: cycles until the queue is drained ----------------------
//
// One cycle reviews at most `limit` revisions and `limit` annotations. The
// write limits allow far more per day, so a single cycle let a busy contributor
// build a backlog that never cleared (found 2026-09-30, after v0.1.1). A night
// runs cycles until the queue is drained, and stops early — never loops — when:
//   - a cycle was paused, tripped a canary, or could not verify its canaries;
//   - a cycle had apply errors (a failed apply records no event, so the same
//     items would come straight back and be billed again, every pass);
//   - the budget stopped it (the run cap is carried across cycles, so $5 is
//     the whole night, not each pass);
//   - the next queue repeats an item already handed out tonight (no progress,
//     for any reason — checked BEFORE paying for another cycle's canaries);
//   - it reached maxPasses (a backstop).
// Each cycle runs its own canaries first: every batch is verified.
export interface NightOptions extends CycleOptions {
  maxPasses?: number;
}

export interface NightReport extends CycleReport {
  passes: number;
  stoppedBecause: string;
  backlogRemaining: boolean;
}

const queueIds = (q: Awaited<ReturnType<NoosphereClient["queue"]>>) => [
  ...q.revisions.map((i) => String(i.revision.id)),
  ...q.annotations.map((i) => String(i.annotation.id)),
];

export async function runNight(o: NightOptions): Promise<NightReport> {
  const limit = o.limit ?? 50;
  const maxPasses = o.maxPasses ?? 10;
  const seen = new Set<string>();
  const night: NightReport = {
    passes: 0, stoppedBecause: "", backlogRemaining: false,
    reviewed: 0, superseded: 0, applied: {}, applyErrors: [], stoppedByBudget: false, monthlyCapReached: false,
    queueFull: false, unverified: false, canaries: [], canaryFailure: false, spendRunUsd: 0, spendMonthUsd: 0,
  };
  for (;;) {
    if (night.passes > 0) {
      const peek = queueIds(await o.client.queue(o.rubricVersion, limit));
      if (peek.length === 0) { night.stoppedBecause = "queue drained"; break; }
      if (peek.some((id) => seen.has(id))) { night.stoppedBecause = "no progress: an item came back"; break; }
    }
    const client = Object.create(o.client) as NoosphereClient;
    client.queue = async (rubric: string, lim?: number) => {
      const q = await o.client.queue(rubric, lim);
      for (const id of queueIds(q)) seen.add(id);
      return q;
    };
    const r = await runCycle({ ...o, client, runCapUsd: o.runCapUsd - night.spendRunUsd });
    night.passes++;
    night.reviewed += r.reviewed;
    night.superseded += r.superseded;
    for (const [k, v] of Object.entries(r.applied)) night.applied[k] = (night.applied[k] ?? 0) + v;
    night.applyErrors.push(...r.applyErrors);
    night.canaries.push(...r.canaries);
    night.canaryFailure ||= r.canaryFailure;
    night.monthlyCapReached ||= r.monthlyCapReached;
    night.stoppedByBudget = r.stoppedByBudget;
    night.unverified = r.unverified;
    night.queueFull = r.queueFull;
    night.spendRunUsd += r.spendRunUsd;
    night.spendMonthUsd = r.spendMonthUsd;
    if (r.paused !== undefined) night.paused = r.paused;

    if (r.paused !== undefined) night.stoppedBecause = "paused";
    else if (r.canaryFailure) night.stoppedBecause = "canary published: run discarded";
    else if (r.applyErrors.length) night.stoppedBecause = "apply errors";
    else if (r.stoppedByBudget || r.unverified) night.stoppedBecause = r.monthlyCapReached ? "monthly budget" : "run budget";
    else if (!r.queueFull) night.stoppedBecause = "queue drained";
    else if (night.passes >= maxPasses) night.stoppedBecause = "max passes";
    if (night.stoppedBecause) break;
  }
  night.backlogRemaining = night.queueFull && night.stoppedBecause !== "queue drained";
  return night;
}
