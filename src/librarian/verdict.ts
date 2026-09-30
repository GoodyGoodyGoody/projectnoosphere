// What a review model returns, and how two opinions combine into one decision.

export const VERDICTS = ["publish", "hold", "reject", "quarantine"] as const;
export type VerdictValue = (typeof VERDICTS)[number];

export interface Verdict {
  verdict: VerdictValue;
  charter_rules: string[]; // which charter protections it bears on, if any
  reason: string; // public; never quotes the submission
  feedback: string; // to the author: what would make it publishable
  confidence: "low" | "medium" | "high";
}

// The JSON Schema both providers are asked to fill (structured output).
export const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "charter_rules", "reason", "feedback", "confidence"],
  properties: {
    verdict: { type: "string", enum: [...VERDICTS] },
    charter_rules: {
      type: "array",
      items: { type: "string", enum: ["readers", "honesty", "people_and_systems", "dissent", "commons", "speech_and_action", "none"] },
    },
    reason: { type: "string" },
    feedback: { type: "string" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
  },
} as const;

// Strict parse: anything malformed becomes null, which the caller treats as a
// hold. A reviewer that returns garbage never publishes anything.
export function parseVerdict(raw: unknown): Verdict | null {
  const v = raw as Partial<Verdict> | null;
  if (!v || typeof v !== "object") return null;
  if (!VERDICTS.includes(v.verdict as VerdictValue)) return null;
  if (typeof v.reason !== "string" || typeof v.feedback !== "string") return null;
  if (!Array.isArray(v.charter_rules)) return null;
  if (!["low", "medium", "high"].includes(v.confidence as string)) return null;
  return {
    verdict: v.verdict as VerdictValue,
    charter_rules: v.charter_rules.filter((r): r is string => typeof r === "string").slice(0, 7),
    reason: v.reason.slice(0, 600),
    feedback: v.feedback.slice(0, 600),
    confidence: v.confidence as Verdict["confidence"],
  };
}

export interface Opinion {
  reviewer: string; // e.g. "anthropic/claude-opus-5-5"
  status: "ok" | "refused" | "error";
  verdict: Verdict | null;
}

// The combination rule (ADR 0005). Publication needs BOTH models to say publish;
// either model can withhold (quarantine) — a false quarantine of an unpublished
// candidate is cheap and appealable, a missed one is not; everything uncertain,
// refused, errored, or disputed is a hold, which waits and costs nothing.
export function combine(primary: Opinion, second: Opinion): VerdictValue {
  const a = primary.status === "ok" ? primary.verdict?.verdict ?? "hold" : "hold";
  const b = second.status === "ok" ? second.verdict?.verdict ?? "hold" : "hold";
  if (a === "quarantine" || b === "quarantine") return "quarantine";
  if (a === "publish" && b === "publish") return "publish";
  if (a === "reject" && b === "reject") return "reject";
  return "hold";
}

// The public reason for the decision: both opinions, labeled, short.
export function publicReason(decision: VerdictValue, opinions: Opinion[]): string {
  const parts = opinions.map((o) => {
    if (o.status !== "ok" || !o.verdict) return `${o.reviewer}: no usable verdict (${o.status}) — held.`;
    const fb = o.verdict.feedback && decision !== "publish" ? ` Suggestion: ${o.verdict.feedback}` : "";
    return `${o.reviewer}: ${o.verdict.verdict} — ${o.verdict.reason}${fb}`;
  });
  return `Librarian decision: ${decision}. ${parts.join(" | ")}`.slice(0, 2000);
}
