import type { Opinion } from "./verdict.ts";

export interface Usage {
  inputTokens: number;
  outputTokens: number; // includes any thinking/reasoning tokens, which are billed as output
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface ReviewInput {
  kind: "revision" | "annotation";
  system: string;
  user: string;
}

export interface ReviewResult extends Opinion {
  usage: Usage;
  costUsd: number;
}

// A review model. No tools: it can only return a verdict. Implementations are
// the real providers (part 3) and scripted fakes (tests).
export interface Reviewer {
  id: string;
  // Worst-case cost of one call, for the budget check BEFORE calling.
  maxCostUsd(input: ReviewInput): number;
  review(input: ReviewInput): Promise<ReviewResult>;
}

// Prices per million tokens, dated. Keep in one place; re-check when changing
// models. Sources:
//   Anthropic — the Claude API model table (claude-api skill, cached 2026-09-25):
//     Opus 5.5 $4 in / $20 out, cache reads $0.20; cache writes (5-min) 1.25× input.
//   OpenAI — GPT-6 Sol/Luna from OpenAI's own announcement ("Introducing GPT-6 Sol
//     and Luna", read 2026-09-30); GPT-5.4 mini from pricing summaries (unverified).
//   OpenAI cached-input discounts are ignored here: estimates stay conservative.
export const PRICES_USD_PER_MTOK: Record<
  string,
  { input: number; output: number; cacheRead?: number; cacheWrite?: number; asOf: string }
> = {
  "anthropic/claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, asOf: "2026-09-25" },
  "openai/gpt-6-sol": { input: 2, output: 10, asOf: "2026-09-30 (OpenAI announcement)" },
  "openai/gpt-6-luna": { input: 0.1, output: 0.5, asOf: "2026-09-30 (OpenAI announcement)" },
  "openai/gpt-5.4-mini": { input: 0.75, output: 4.5, asOf: "2026-09 (unverified summary)" },
};

export function costOf(model: string, usage: Usage): number {
  const p = PRICES_USD_PER_MTOK[model];
  if (!p) throw new Error(`no price for ${model}`);
  return (
    usage.inputTokens * p.input +
    (usage.cacheWriteTokens ?? 0) * (p.cacheWrite ?? p.input) +
    (usage.cacheReadTokens ?? 0) * (p.cacheRead ?? p.input) +
    usage.outputTokens * p.output
  ) / 1_000_000;
}

// Worst case for one call, before making it: every input token uncached (or
// written to cache, whichever is dearer) and the full output allowance used.
export function worstCaseUsd(model: string, input: ReviewInput, maxOutputTokens: number): number {
  const p = PRICES_USD_PER_MTOK[model];
  if (!p) throw new Error(`no price for ${model}`);
  const inPrice = Math.max(p.input, p.cacheWrite ?? 0);
  return (estimateInputTokens(input) * inPrice + maxOutputTokens * p.output) / 1_000_000;
}

// Rough, deliberately generous token estimate for the pre-call budget check.
export function estimateInputTokens(input: ReviewInput): number {
  return Math.ceil((input.system.length + input.user.length) / 3);
}
