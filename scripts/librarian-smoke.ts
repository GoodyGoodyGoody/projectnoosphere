// A small live test of the real review models on the planted canaries only
// (synthetic content, nothing from the site). Prints each verdict, tokens, and
// cost; appends every call to the spend ledger so it counts toward the cap.
//   npm run librarian-smoke
import { join } from "node:path";
import { CANARIES } from "../src/librarian/canaries.ts";
import { buildUserMessage, SYSTEM_PROMPT } from "../src/librarian/prompt.ts";
import { anthropicReviewer, openaiReviewer } from "../src/librarian/providers.ts";
import type { Reviewer, ReviewResult } from "../src/librarian/reviewer.ts";
import { SpendLedger } from "../src/librarian/spend.ts";
import { combine } from "../src/librarian/verdict.ts";
import { DATA_DIR } from "../src/paths.ts";

process.loadEnvFile(join(import.meta.dirname, "..", ".env"));
const SMOKE_CAP_USD = 2;
const ledger = new SpendLedger(join(DATA_DIR, "librarian-spend.jsonl"));
const openaiKey = process.env.OPENAI_API_KEY!;
const reviewers: Record<string, Reviewer> = {
  "opus-medium": anthropicReviewer({ model: "claude-opus-5-5", effort: "medium", maxTokens: 4000 }),
  "opus-low": anthropicReviewer({ model: "claude-opus-5-5", effort: "low", maxTokens: 4000 }),
  "gpt-6-sol": openaiReviewer({ model: "gpt-6-sol", reasoningEffort: "medium", maxTokens: 4000, apiKey: openaiKey }),
  "gpt-5.4-mini": openaiReviewer({ model: "gpt-5.4-mini", reasoningEffort: "medium", maxTokens: 4000, apiKey: openaiKey }),
};

let spent = 0;
const results: Record<string, Record<string, ReviewResult>> = {};
for (const c of CANARIES) {
  results[c.name] = {};
  const input = { kind: c.kind, system: SYSTEM_PROMPT, user: buildUserMessage(c.kind, c.payload) };
  for (const [label, r] of Object.entries(reviewers)) {
    if (spent + r.maxCostUsd(input) > SMOKE_CAP_USD) { console.log(`stop: smoke cap $${SMOKE_CAP_USD}`); process.exit(0); }
    let out: ReviewResult;
    try { out = await r.review(input); }
    catch (e) { console.log(`${c.name} | ${label} | ERROR ${(e as Error).message.slice(0, 120)}`); continue; }
    spent += out.costUsd;
    results[c.name]![label] = out;
    ledger.append({ at: new Date().toISOString(), month: new Date().toISOString().slice(0, 7), reviewer: out.reviewer, target: `smoke:${c.name}`, inputTokens: out.usage.inputTokens, outputTokens: out.usage.outputTokens, costUsd: out.costUsd });
    const u = out.usage;
    console.log(`${c.name.padEnd(32)} | ${label.padEnd(12)} | ${(out.verdict?.verdict ?? out.status).padEnd(10)} | in ${u.inputTokens}${u.cacheReadTokens ? `+${u.cacheReadTokens}c` : ""}${u.cacheWriteTokens ? `+${u.cacheWriteTokens}w` : ""} out ${u.outputTokens} | $${out.costUsd.toFixed(4)}`);
  }
}
console.log(`\nTOTAL $${spent.toFixed(4)}`);
for (const pair of [["opus-medium", "gpt-6-sol"], ["opus-medium", "gpt-5.4-mini"], ["opus-low", "gpt-6-sol"]] as const) {
  const line = CANARIES.map((c) => {
    const a = results[c.name]?.[pair[0]], b = results[c.name]?.[pair[1]];
    if (!a || !b) return `${c.name}: n/a`;
    const d = combine(a, b);
    const ok = c.expect === "publish" ? d === "publish" : d !== "publish";
    return `${ok ? "ok " : "BAD"} ${c.name} → ${d}`;
  });
  const perItem = CANARIES.reduce((s, c) => s + (results[c.name]?.[pair[0]]?.costUsd ?? 0) + (results[c.name]?.[pair[1]]?.costUsd ?? 0), 0) / CANARIES.length;
  console.log(`\n${pair.join(" + ")}  (avg $${perItem.toFixed(4)}/item)\n  ${line.join("\n  ")}`);
}
