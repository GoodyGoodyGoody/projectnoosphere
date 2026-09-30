import Anthropic from "@anthropic-ai/sdk";
import { costOf, worstCaseUsd, type Reviewer, type ReviewInput, type ReviewResult } from "./reviewer.ts";
import { parseVerdict, VERDICT_SCHEMA } from "./verdict.ts";

// The real review models. Neither gets tools: each can only return a verdict,
// as structured output validated against VERDICT_SCHEMA and then re-checked by
// parseVerdict. Anything else — refusal, malformed output, API error — is not
// a verdict, and the combination rule turns it into a hold.
//
// Refusals are deliberately NOT rerouted to a fallback model (the SDK's
// server-side fallback): a two-provider rule needs to know which model spoke.
// A refused review is simply a hold.

export function anthropicReviewer(opts: {
  model: string; // e.g. "claude-opus-5-5"
  effort: "low" | "medium" | "high";
  maxTokens: number; // bounds output including thinking
  apiKey?: string;
}): Reviewer {
  const id = `anthropic/${opts.model}`;
  const client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
  return {
    id,
    maxCostUsd: (input: ReviewInput) => worstCaseUsd(id, input, opts.maxTokens),
    async review(input: ReviewInput): Promise<ReviewResult> {
      const res = await client.messages.create({
        model: opts.model,
        max_tokens: opts.maxTokens,
        // The charter + rubric is identical on every call: cache it.
        system: [{ type: "text", text: input.system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: input.user }],
        output_config: {
          effort: opts.effort,
          format: { type: "json_schema", schema: VERDICT_SCHEMA as unknown as Record<string, unknown> },
        },
      } as Anthropic.MessageCreateParamsNonStreaming);
      const usage = {
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
        cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
      };
      const costUsd = costOf(id, usage);
      if (res.stop_reason === "refusal") return { reviewer: id, status: "refused", verdict: null, usage, costUsd };
      const text = res.content.find((b) => b.type === "text");
      let verdict = null;
      try {
        verdict = text && "text" in text ? parseVerdict(JSON.parse(text.text)) : null;
      } catch {
        verdict = null;
      }
      return { reviewer: id, status: verdict ? "ok" : "error", verdict, usage, costUsd };
    },
  };
}

export function openaiReviewer(opts: {
  model: string; // e.g. "gpt-6-sol"
  reasoningEffort?: "low" | "medium" | "high";
  maxTokens: number;
  apiKey: string;
}): Reviewer {
  const id = `openai/${opts.model}`;
  return {
    id,
    maxCostUsd: (input: ReviewInput) => worstCaseUsd(id, input, opts.maxTokens),
    async review(input: ReviewInput): Promise<ReviewResult> {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: opts.model,
          messages: [
            { role: "system", content: input.system },
            { role: "user", content: input.user },
          ],
          response_format: { type: "json_schema", json_schema: { name: "verdict", strict: true, schema: VERDICT_SCHEMA } },
          max_completion_tokens: opts.maxTokens,
          ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
        }),
        signal: AbortSignal.timeout(120_000),
      });
      const body = (await res.json()) as any;
      if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${body?.error?.message ?? "unknown error"}`);
      const usage = {
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
      };
      const costUsd = costOf(id, usage);
      const msg = body.choices?.[0]?.message;
      if (msg?.refusal) return { reviewer: id, status: "refused", verdict: null, usage, costUsd };
      let verdict = null;
      try {
        verdict = typeof msg?.content === "string" ? parseVerdict(JSON.parse(msg.content)) : null;
      } catch {
        verdict = null;
      }
      return { reviewer: id, status: verdict ? "ok" : "error", verdict, usage, costUsd };
    },
  };
}
