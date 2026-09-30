import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

// Model spend, as an append-only JSONL ledger (one line per call) in the data
// directory. Appending never truncates, so a crash mid-write cannot lose the
// history; the month's total is recomputed from the file.
export interface SpendEntry {
  at: string;
  month: string; // YYYY-MM (UTC)
  reviewer: string;
  target: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export class SpendLedger {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }

  monthTotal(month: string): number {
    if (!existsSync(this.path)) return 0;
    let total = 0;
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as SpendEntry;
        if (e.month === month) total += e.costUsd;
      } catch {
        // A torn last line from a crash is skipped, never fatal.
      }
    }
    return total;
  }

  // Creates its directory if needed: a spend record must never be lost because
  // the data directory did not exist yet (found in the first live smoke test,
  // which lost one call's cost this way).
  append(entry: SpendEntry): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    appendFileSync(this.path, JSON.stringify(entry) + "\n", { mode: 0o600 });
  }
}
