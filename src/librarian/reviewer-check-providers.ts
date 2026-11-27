// Trial-only structured output transport. No tools and no command execution.
import Anthropic from "@anthropic-ai/sdk";
import { costOf, worstCaseUsd } from "./reviewer.ts";
import { TRIAL_REVIEWERS, type TrialReviewer } from "./reviewer-check-trial.ts";

const parse = (s: string | undefined): unknown => {
  try { return s ? JSON.parse(s) : null; } catch { return null; }
};
export function reviewerCheckProviders(): [TrialReviewer, TrialReviewer] {
  if (!process.env.ANTHROPIC_API_KEY || !process.env.OPENAI_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY and OPENAI_API_KEY must be set");
  }
  const client = new Anthropic({ maxRetries: 0, timeout: 120_000 });
  const [claude, gpt] = TRIAL_REVIEWERS;
  return [{
    id: claude.id,
    maxCostUsd: (input) => worstCaseUsd(claude.id, { ...input, system: input.system + JSON.stringify(input.schema) }, claude.maxTokens),
    async call(input) {
      const res = await client.messages.create({
        model: claude.model, max_tokens: claude.maxTokens,
        system: [{ type: "text", text: input.system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: input.user }],
        output_config: { effort: claude.effort, format: { type: "json_schema", schema: input.schema } },
      } as Anthropic.MessageCreateParamsNonStreaming);
      const usage = { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens,
        cacheReadTokens: res.usage.cache_read_input_tokens ?? 0, cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0 };
      const value = parse(res.content.find((b) => b.type === "text")?.text);
      return { value, usage, costUsd: costOf(claude.id, usage),
        status: res.stop_reason === "refusal" ? "refused" : value ? "ok" : "error" };
    },
  }, {
    id: gpt.id,
    maxCostUsd: (input) => worstCaseUsd(gpt.id, { ...input, system: input.system + JSON.stringify(input.schema) }, gpt.maxTokens),
    async call(input) {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST", headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ model: gpt.model, max_completion_tokens: gpt.maxTokens, reasoning_effort: gpt.effort,
          messages: [{ role: "system", content: input.system }, { role: "user", content: input.user }],
          response_format: { type: "json_schema", json_schema: { name: "reviewer_check_trial", strict: true, schema: input.schema } } }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`);
      const body = await res.json() as any;
      const usage = { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 };
      const msg = body.choices?.[0]?.message;
      const value = parse(msg?.content);
      return { value, usage, costUsd: costOf(gpt.id, usage), status: msg?.refusal ? "refused" : value ? "ok" : "error" };
    },
  }];
}
