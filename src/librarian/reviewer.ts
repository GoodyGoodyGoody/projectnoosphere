import type { Opinion } from "./verdict.ts";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
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
// models. Sources: Anthropic model table (claude-api skill, cached 2026-09-25);
// OpenAI per third-party summaries 2026-09 — verify on OpenAI's pricing page
// before relying on it.
export const PRICES_USD_PER_MTOK: Record<string, { input: number; output: number; asOf: string }> = {
  "anthropic/claude-opus-5-5": { input: 4, output: 20, asOf: "2026-09-25" },
  "openai/gpt-5.4-mini": { input: 0.75, output: 4.5, asOf: "2026-09 (unverified summary)" },
};

export function costOf(model: string, usage: Usage): number {
  const p = PRICES_USD_PER_MTOK[model];
  if (!p) throw new Error(`no price for ${model}`);
  return (usage.inputTokens * p.input + usage.outputTokens * p.output) / 1_000_000;
}

// Rough, deliberately generous token estimate for the pre-call budget check.
export function estimateInputTokens(input: ReviewInput): number {
  return Math.ceil((input.system.length + input.user.length) / 3);
}
