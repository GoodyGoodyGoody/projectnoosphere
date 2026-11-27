import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { reviewerCheckProviders } from "../src/librarian/reviewer-check-providers.ts";
import { openTrialDb, runReviewerCheckTrial, saveTrialReport, selectTrialItems, trialTable } from "../src/librarian/reviewer-check-trial.ts";
import { SpendLedger } from "../src/librarian/spend.ts";

export async function reviewerCheckSmoke(): Promise<void> {
  // Resolve only after the same environment loading as ordinary smoke. No cwd fallback.
  const dir = process.env.SITE_DATA_DIR;
  if (!dir || !isAbsolute(dir)) throw new Error("Reviewer-check trial requires an absolute SITE_DATA_DIR matching the nightly librarian");
  const db = openTrialDb(join(dir, "noosphere.sqlite"));
  let items;
  try { items = selectTrialItems(db); } finally { db.close(); }
  console.log("Selected items:\n" + items.map((i) => `${i.source}: ${i.id}`).join("\n"));
  const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  let path = "";
  const report = await runReviewerCheckTrial({ items, reviewers: reviewerCheckProviders(),
    ledger: new SpendLedger(join(dir, "librarian-spend.jsonl")),
    save: (r) => { path = saveTrialReport(dir, name, r); },
  });
  console.log(trialTable(report));
  console.log(`JSON: ${path}`);
  if (report.stoppedBecause || report.rows.some((r) => r.draftStatus !== "ok" || r.judgeStatus !== "ok")) process.exitCode = 1;
}
