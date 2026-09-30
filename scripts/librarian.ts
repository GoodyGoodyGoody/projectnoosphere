// The librarian's controls. Runs on the host, talks to Noosphere only through
// its HTTP API with a steward token (NOOSPHERE_LIBRARIAN_TOKEN).
//
//   npm run librarian -- status
//   npm run librarian -- pause "reason"
//   npm run librarian -- resume
//   npm run librarian -- run --dry-run      # full cycle, stub reviewers that hold everything, $0
//   npm run librarian -- run                # real models (wired in 2c part 3)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NoosphereClient } from "../src/librarian/client.ts";
import { scriptedReviewer } from "../src/librarian/fake.ts";
import { RUBRIC_VERSION } from "../src/librarian/prompt.ts";
import { runCycle } from "../src/librarian/run.ts";
import { SpendLedger } from "../src/librarian/spend.ts";
import { DATA_DIR } from "../src/paths.ts";

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
    throw new Error("real reviewers are wired in 2c part 3; use --dry-run for now");
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
