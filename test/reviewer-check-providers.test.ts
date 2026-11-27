import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewerCheckProviders } from "../src/librarian/reviewer-check-providers.ts";
import { DRAFT_SCHEMA, TRIAL_REVIEWERS, trialInput } from "../src/librarian/reviewer-check-trial.ts";

test("trial transports use production settings and draft/judge schemas with no tools (mock HTTP only)", async (t) => {
  const oldClaude = process.env.ANTHROPIC_API_KEY, oldOpenai = process.env.OPENAI_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-only";
  process.env.OPENAI_API_KEY = "test-only";
  const bodies: any[] = [];
  const value = { promise: "The promise", run: null, expect: null, no_check: "No offline interface exists" };
  t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
    const request = new Request(url, init);
    bodies.push(await request.json());
    const anthropic = request.url.includes("anthropic");
    return Response.json(anthropic
      ? { id: "test", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn",
        content: [{ type: "text", text: JSON.stringify(value) }], usage: { input_tokens: 100, output_tokens: 20 } }
      : { choices: [{ message: { content: JSON.stringify(value) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
  });
  try {
    const reviewers = reviewerCheckProviders();
    const input = trialInput({ id: "test", source: "published", kind: "revision", payload: { title: "Test" } });
    for (const reviewer of reviewers) {
      const result = await reviewer.call(input);
      assert.deepEqual(result.value, value);
      assert.equal(result.status, "ok");
      assert.ok(result.costUsd > 0 && result.costUsd < reviewer.maxCostUsd(input));
    }
    assert.deepEqual(reviewers.map((r) => r.id), TRIAL_REVIEWERS.map((r) => r.id));
    assert.equal(bodies[0].model, "claude-opus-5-5");
    assert.equal(bodies[0].max_tokens, 4000);
    assert.equal(bodies[0].output_config.effort, "medium");
    assert.deepEqual(bodies[0].output_config.format.schema, DRAFT_SCHEMA);
    assert.equal(bodies[1].model, "gpt-6-sol");
    assert.equal(bodies[1].max_completion_tokens, 4000);
    assert.equal(bodies[1].reasoning_effort, "medium");
    assert.deepEqual(bodies[1].response_format.json_schema.schema, DRAFT_SCHEMA);
    assert.equal(bodies[1].response_format.json_schema.strict, true);
    for (const body of bodies) assert.equal(body.tools, undefined);
  } finally {
    if (oldClaude === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = oldClaude;
    if (oldOpenai === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldOpenai;
  }
});
