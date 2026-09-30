import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
  // Called once per model call (the CLI reports to the bots dashboard).
  onUsage?: (reviewer: string, inputTokens: number, outputTokens: number) => void | Promise<void>;
}

interface WorkItem {
  kind: "revision" | "annotation";
  targetId: string;
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
    id: a.id, kind: a.kind, outcome: a.outcome, body: a.body, evidence: a.evidence, conditions: a.conditions,
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
    reviewed: 0, superseded: 0, applied: {}, applyErrors: [], stoppedByBudget: false, unverified: false,
    canaries: [], canaryFailure: false, spendRunUsd: 0, spendMonthUsd: o.ledger.monthTotal(month),
  };

  if (existsSync(o.pauseFile)) {
    report.paused = readFileSync(o.pauseFile, "utf8").trim() || "paused";
    return report;
  }

  const queue = await o.client.queue(o.rubricVersion, o.limit ?? 50);
  const stale = queue.revisions.filter((i) => i.base_is_stale).map((i) => i.revision.id as string);
  const canaries = o.canaries ?? pickCanaries(now.toISOString());
  const work: WorkItem[] = [
    // Canaries first, so a budget stop can never leave a run unverified by chance.
    ...canaries.map((c) => ({ kind: c.kind, targetId: String(c.payload.id), payload: c.payload, canary: c })),
    ...queue.revisions.filter((i) => !i.base_is_stale).map((i) => ({ kind: "revision" as const, targetId: i.revision.id, payload: revisionPayload(i) })),
    ...queue.annotations.map((i) => ({ kind: "annotation" as const, targetId: i.annotation.id, payload: annotationPayload(i) })),
  ];

  const decided: Decided[] = [];
  for (const item of work) {
    const input: ReviewInput = { kind: item.kind, system: SYSTEM_PROMPT, user: buildUserMessage(item.kind, item.payload) };
    const worst = o.primary.maxCostUsd(input) + o.second.maxCostUsd(input);
    if (report.spendMonthUsd + report.spendRunUsd + worst > o.monthlyCapUsd || report.spendRunUsd + worst > o.runCapUsd) {
      report.stoppedByBudget = true;
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
    if (res.status === 201) tally(action);
    else report.applyErrors.push(`${d.targetId} ${action}: HTTP ${res.status} ${res.body?.error?.code ?? ""}`);
  }
  return report;
}
