// A small live test of the real review models on the planted canaries only
// (synthetic content, nothing from the site). Prints each verdict, tokens, and
// cost; appends every call to the spend ledger so it counts toward the cap.
//   npm run librarian-smoke
//   npm run librarian-smoke -- --trial  # trials only, production pair, 3 runs
import { isAbsolute, join } from "node:path";
import { selectSmoke } from "../src/librarian/smoke-selection.ts";
import { buildUserMessage, SYSTEM_PROMPT } from "../src/librarian/prompt.ts";
import { anthropicReviewer, openaiReviewer } from "../src/librarian/providers.ts";
import type { Reviewer, ReviewResult } from "../src/librarian/reviewer.ts";
import { SpendLedger } from "../src/librarian/spend.ts";
import { combine } from "../src/librarian/verdict.ts";
import { DATA_DIR } from "../src/paths.ts";

// Dispatch before constructing ordinary smoke providers. The trial is manual only.
const selection = selectSmoke(process.argv.slice(2));
if (selection.reviewerChecks) {
  process.loadEnvFile(join(import.meta.dirname, "..", ".env"));
  const { reviewerCheckSmoke } = await import("./reviewer-check-smoke.ts");
  await reviewerCheckSmoke();
} else {
if (selection.canaries.length === 0) {
  console.log("No trial canaries to run.");
  process.exit(0);
}
process.loadEnvFile(join(import.meta.dirname, "..", ".env"));
const SMOKE_CAP_USD = 2;
// Trials must charge the nightly ledger, including when SITE_DATA_DIR comes
// from .env (src/paths.ts was evaluated before that file was loaded).
const ledgerDir = selection.trial ? process.env.SITE_DATA_DIR : DATA_DIR;
if (!ledgerDir || (selection.trial && !isAbsolute(ledgerDir))) {
  throw new Error("Trial smoke requires an absolute SITE_DATA_DIR matching the nightly librarian.");
}
const ledger = new SpendLedger(join(ledgerDir, "librarian-spend.jsonl"));
const openaiKey = process.env.OPENAI_API_KEY!;
const reviewers: Record<string, Reviewer> = {
  "opus-medium": anthropicReviewer({ model: "claude-opus-5-5", effort: "medium", maxTokens: 4000 }),
  "opus-low": anthropicReviewer({ model: "claude-opus-5-5", effort: "low", maxTokens: 4000 }),
  "gpt-6-sol": openaiReviewer({ model: "gpt-6-sol", reasoningEffort: "medium", maxTokens: 4000, apiKey: openaiKey }),
  "gpt-5.4-mini": openaiReviewer({ model: "gpt-5.4-mini", reasoningEffort: "medium", maxTokens: 4000, apiKey: openaiKey }),
};

let spent = 0;
const results: Record<string, Record<string, ReviewResult>> = {};
items: for (const c of selection.canaries) {
 for (let repetition = 1; repetition <= selection.repetitions; repetition++) {
  const name = selection.trial ? `${c.name} [run ${repetition}]` : c.name;
  results[name] = {};
  const input = { kind: c.kind, system: SYSTEM_PROMPT, user: buildUserMessage(c.kind, c.payload) };
  for (const label of selection.reviewerLabels) {
    const r = reviewers[label]!;
    if (spent + r.maxCostUsd(input) > SMOKE_CAP_USD) {
      console.log(`stop: smoke cap $${SMOKE_CAP_USD}`);
      if (selection.trial) { process.exitCode = 1; break items; }
      process.exit(0);
    }
    let out: ReviewResult;
    try { out = await r.review(input); }
    catch (e) { console.log(`${name} | ${label} | ERROR ${(e as Error).message.replace(/\s+/g, " ").slice(0, 120)} | cost unknown`); continue; }
    spent += out.costUsd;
    results[name]![label] = out;
    ledger.append({ at: new Date().toISOString(), month: new Date().toISOString().slice(0, 7), reviewer: out.reviewer, target: `smoke:${c.name}`, inputTokens: out.usage.inputTokens, outputTokens: out.usage.outputTokens, costUsd: out.costUsd });
    const u = out.usage;
    const reason = selection.trial ? ` | ${(out.verdict?.reason ?? `no usable verdict (${out.status})`).replace(/\s+/g, " ")}` : "";
    console.log(`${name.padEnd(32)} | ${label.padEnd(12)} | ${(out.verdict?.verdict ?? out.status).padEnd(10)}${reason} | in ${u.inputTokens}${u.cacheReadTokens ? `+${u.cacheReadTokens}c` : ""}${u.cacheWriteTokens ? `+${u.cacheWriteTokens}w` : ""} out ${u.outputTokens} | $${out.costUsd.toFixed(4)}`);
  }
 }
}
console.log(`\nTOTAL $${spent.toFixed(4)}`);
for (const pair of selection.pairs) {
  const line = selection.canaries.flatMap((c) => Array.from({ length: selection.repetitions }, (_, i) => {
    const name = selection.trial ? `${c.name} [run ${i + 1}]` : c.name;
    const a = results[name]?.[pair[0]!], b = results[name]?.[pair[1]!];
    if (!a || !b) return `${name}: n/a (incomplete)`;
    const d = combine(a, b);
    const ok = c.expect === "publish" ? d === "publish" : d !== "publish";
    return `${ok ? "ok " : "BAD"} ${name} → ${d}`;
  }));
  const perItem = Object.values(results).reduce((s, r) => s + (r[pair[0]!]?.costUsd ?? 0) + (r[pair[1]!]?.costUsd ?? 0), 0) / (selection.canaries.length * selection.repetitions);
  console.log(`\n${pair.join(" + ")}  (avg $${perItem.toFixed(4)}/item)\n  ${line.join("\n  ")}`);
}
}
