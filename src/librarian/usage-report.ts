// Fire-and-forget LLM usage telemetry to the bots dashboard (the droplet's
// shared spend ledger, on its local port), the same shape every other bot
// reports. It feeds the fleet-wide spend alerts. It never throws and never
// slows a run by more than its short timeout; the librarian's own spend ledger
// and cap do not depend on it.
export async function reportUsage(bot: string, model: string, inTok: number, outTok: number): Promise<void> {
  if (!model || (!inTok && !outTok)) return;
  try {
    await fetch("http://127.0.0.1:3011/api/usage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bot, model, in_tok: inTok, out_tok: outTok }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    /* dashboard offline — telemetry is best-effort */
  }
}
