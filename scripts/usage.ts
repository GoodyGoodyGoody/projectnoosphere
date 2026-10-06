// The private usage counts (src/usage.ts), read from SITE_DATA_DIR's database.
// No public route serves these.
//
//   npm run usage -- [--days 7] [--json]
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { DB_PATH } from "../src/paths.ts";
import { formatUsageReport, usageReport } from "../src/usage-report.ts";

export function main(argv: string[], dbPath: string = DB_PATH): { code: number; out: string } {
  let values: { days?: string; json?: boolean };
  try {
    ({ values } = parseArgs({ args: argv, options: { days: { type: "string" }, json: { type: "boolean" } } }));
  } catch (err) {
    return { code: 2, out: `${(err as Error).message}\nusage: npm run usage -- [--days N] [--json]` };
  }
  const days = values.days === undefined ? 7 : Number(values.days);
  if (!Number.isInteger(days) || days < 1 || days > 366) return { code: 2, out: "--days must be a whole number from 1 to 366" };
  if (!existsSync(dbPath)) return { code: 1, out: `no database at ${dbPath}` };
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'usage_counts'").get();
    if (!has) return { code: 1, out: "no usage tables yet: run `npm run cli -- migrate` (migration 007)" };
    const report = usageReport(db, { days });
    return { code: 0, out: values.json ? JSON.stringify(report, null, 2) : formatUsageReport(report) };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const { code, out } = main(process.argv.slice(2));
  (code === 0 ? console.log : console.error)(out);
  process.exit(code);
}
