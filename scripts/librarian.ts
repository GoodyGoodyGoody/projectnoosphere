// The librarian's controls. Runs on the host, talks to Noosphere only through
// its HTTP API with a steward token (NOOSPHERE_LIBRARIAN_TOKEN).
//
//   npm run librarian -- status
//   npm run librarian -- pause "reason"
//   npm run librarian -- resume
//   npm run librarian -- run --dry-run      # full cycle, stub reviewers that hold everything, $0
//   npm run librarian -- run                # real models: Claude Opus 5.5 + GPT-6 Sol
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { NoosphereClient } from "../src/librarian/client.ts";
import { scriptedReviewer } from "../src/librarian/fake.ts";
import { anthropicReviewer, openaiReviewer } from "../src/librarian/providers.ts";
import { RUBRIC_VERSION } from "../src/librarian/prompt.ts";
import { runCycle } from "../src/librarian/run.ts";
import { reportUsage } from "../src/librarian/usage-report.ts";
import { SpendLedger } from "../src/librarian/spend.ts";

// Provider keys (and, for cron, SITE_DATA_DIR) live in this repo's .env
// (gitignored, mode 600). NOOSPHERE_ENV_FILE overrides the path (tests).
try {
  process.loadEnvFile(process.env.NOOSPHERE_ENV_FILE ?? join(import.meta.dirname, "..", ".env"));
} catch {
  /* no .env: only status/pause/resume/dry-run work */
}

// The pause file and the spend ledger MUST be the production ones. Resolving
// them from src/paths.ts would be wrong twice over: that module is evaluated at
// import time (before .env loads), and it falls back to ./data — so a `pause`
// run from a shell without SITE_DATA_DIR would write a pause file the nightly
// run never reads, and report success. So: no fallback, ever.
const DATA_DIR = process.env.SITE_DATA_DIR ?? "";
if (!DATA_DIR || !isAbsolute(DATA_DIR)) {
  console.error("SITE_DATA_DIR must be set to an absolute path (the same one the site and the nightly run use).");
  process.exit(2);
}
const PAUSE_FILE = join(DATA_DIR, "librarian.paused");
const LEDGER = new SpendLedger(join(DATA_DIR, "librarian-spend.jsonl"));
const MONTHLY_CAP = Number(process.env.LIBRARIAN_MONTHLY_CAP_USD ?? 50); // Randall's cap, 2026-09-30
const RUN_CAP = Number(process.env.LIBRARIAN_RUN_CAP_USD ?? 5);

function notify(subject: string, body: string): void {
  const bin = process.env.NOTIFY_BIN ?? "/home/randall/bin/notify";
  try {
    execFileSync(bin, [subject, body], { stdio: "ignore", timeout: 30_000 });
  } catch (err) {
    // The alarm must never fail silently: say so loudly in the log.
    console.error(`ALARM NOT DELIVERED (${bin}): ${subject}`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const month = new Date().toISOString().slice(0, 7);

if (cmd === "status") {
  console.log(`data: ${DATA_DIR}`);
  console.log(existsSync(PAUSE_FILE) ? `PAUSED — ${readFileSync(PAUSE_FILE, "utf8").trim()}` : "active");
  console.log(`rubric ${RUBRIC_VERSION}; spend ${month}: $${LEDGER.monthTotal(month).toFixed(4)} of $${MONTHLY_CAP}`);
} else if (cmd === "pause") {
  writeFileSync(PAUSE_FILE, `paused ${new Date().toISOString()}: ${rest.join(" ") || "manual pause"}\n`, { mode: 0o600 });
  console.log("paused");
} else if (cmd === "resume") {
  rmSync(PAUSE_FILE, { force: true });
  console.log("resumed");
} else if (cmd === "run") {
  const token = process.env.NOOSPHERE_LIBRARIAN_TOKEN;
  if (!token) throw new Error("NOOSPHERE_LIBRARIAN_TOKEN is not set");
  const base = process.env.NOOSPHERE_API_BASE ?? `http://127.0.0.1:${process.env.PORT ?? 4400}`;
  if (!rest.includes("--dry-run")) {
    // The chosen pair (2026-09-30 live canary test: all 6 canaries correct,
    // measured ~$0.009 per item with the charter prompt cached).
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!process.env.ANTHROPIC_API_KEY || !openaiKey) throw new Error("ANTHROPIC_API_KEY and OPENAI_API_KEY must be set (.env)");
    const report = await runCycle({
      client: new NoosphereClient(base, token),
      primary: anthropicReviewer({ model: "claude-opus-5-5", effort: "medium", maxTokens: 4000 }),
      second: openaiReviewer({ model: "gpt-6-sol", reasoningEffort: "medium", maxTokens: 4000, apiKey: openaiKey }),
      rubricVersion: RUBRIC_VERSION,
      ledger: LEDGER, monthlyCapUsd: MONTHLY_CAP, runCapUsd: RUN_CAP, pauseFile: PAUSE_FILE, notify,
      // Model ids as the bots dashboard's price table names them.
      onUsage: (reviewer, inTok, outTok) => reportUsage("noosphere-librarian", reviewer.replace(/^[a-z]+\//, ""), inTok, outTok),
    });
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.canaryFailure || report.applyErrors.length ? 1 : 0);
  }
  const hold = () => "hold" as const;
  // A dry run reads the real queue but applies nothing: every moderation call
  // is printed instead of sent.
  class DryRunClient extends NoosphereClient {
    override async moderate(action: string, targetId: string, reason: string) {
      console.log(`[dry-run] would ${action} ${targetId}: ${reason.slice(0, 160)}`);
      return { status: 201, body: { dry_run: true } };
    }
  }
  const report = await runCycle({
    client: new DryRunClient(base, token),
    primary: scriptedReviewer("dry-run/primary", hold),
    second: scriptedReviewer("dry-run/second", hold),
    rubricVersion: RUBRIC_VERSION,
    ledger: LEDGER, monthlyCapUsd: MONTHLY_CAP, runCapUsd: RUN_CAP, pauseFile: PAUSE_FILE, notify,
  });
  console.log(JSON.stringify(report, null, 2));
} else {
  console.error("usage: librarian status | pause [reason] | resume | run [--dry-run]");
  process.exitCode = 2;
}
