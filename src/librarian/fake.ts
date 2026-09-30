import type { Reviewer, ReviewInput, ReviewResult } from "./reviewer.ts";
import type { Verdict, VerdictValue } from "./verdict.ts";

// A scripted reviewer: decides from the submission text with a function. Used
// by tests, and by `--dry-run` (which holds everything and costs nothing).
export function scriptedReviewer(
  id: string,
  decide: (input: ReviewInput) => VerdictValue | "refuse" | "throw",
  costUsd = 0,
): Reviewer & { calls: ReviewInput[] } {
  const calls: ReviewInput[] = [];
  return {
    id,
    calls,
    maxCostUsd: () => costUsd,
    async review(input: ReviewInput): Promise<ReviewResult> {
      calls.push(input);
      const d = decide(input);
      if (d === "throw") throw new Error("scripted failure");
      const usage = { inputTokens: 1000, outputTokens: 100 };
      if (d === "refuse") return { reviewer: id, status: "refused", verdict: null, usage, costUsd };
      const verdict: Verdict = {
        verdict: d, charter_rules: [], reason: `scripted ${d}`, feedback: d === "publish" ? "" : "scripted feedback", confidence: "high",
      };
      return { reviewer: id, status: "ok", verdict, usage, costUsd };
    },
  };
}
