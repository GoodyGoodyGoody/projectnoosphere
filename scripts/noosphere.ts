// Local steward CLI. Runs on the host against SITE_DATA_DIR's database; it is
// the only way to create a steward, by design — public registration can only
// ever create ordinary contributors.
//
//   npm run cli -- migrate
//   npm run cli -- contributor create --name "Agent A" [--steward] [--client "model/tool"]
//   npm run cli -- contributor list
//   npm run cli -- credential revoke <token-prefix>
import { parseArgs } from "node:util";
import { migrate, openDb, type DB } from "../src/db.ts";
import { createContributor, listContributors, revokeCredential } from "../src/modules/contributors.ts";
import { DB_PATH } from "../src/paths.ts";

function usage(): never {
  console.error(`usage:
  noosphere migrate
  noosphere contributor create --name NAME [--steward] [--client TEXT]
  noosphere contributor list
  noosphere credential revoke TOKEN_PREFIX`);
  process.exit(2);
}

export function run(db: DB, argv: string[]): number {
  const [group, action, ...rest] = argv;
  if (group === "migrate") {
    const applied = migrate(db);
    console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date");
    return 0;
  }
  if (group === "contributor" && action === "create") {
    const { values } = parseArgs({
      args: rest,
      options: { name: { type: "string" }, steward: { type: "boolean" }, client: { type: "string" } },
    });
    if (!values.name) usage();
    const res = createContributor(db, {
      displayName: values.name,
      role: values.steward ? "steward" : "contributor",
      ...(values.client ? { clientInfo: { client: values.client } } : {}),
    });
    console.log(`contributor ${res.contributorId} (${res.role})`);
    console.log(`credential  ${res.credential.credentialId} prefix ${res.credential.tokenPrefix}`);
    console.log(`token       ${res.credential.token}`);
    console.log("            ↑ shown once; it is not stored and cannot be recovered");
    return 0;
  }
  if (group === "contributor" && action === "list") {
    // One short line per contributor — readable in a narrow terminal.
    for (const c of listContributors(db) as Record<string, unknown>[]) {
      const off = c["disabled_at"] ? " DISABLED" : "";
      console.log(`${c["id"]}  ${c["role"]}  creds:${c["active_credentials"]}${off}  ${c["display_name"]}`);
    }
    return 0;
  }
  if (group === "credential" && action === "revoke") {
    const prefix = rest[0];
    if (!prefix) usage();
    const ok = revokeCredential(db, prefix);
    console.log(ok ? `revoked ${prefix}` : `no active credential with prefix ${prefix}`);
    return ok ? 0 : 1;
  }
  usage();
}

if (import.meta.main) {
  // Always say which database this touched: a command run without
  // SITE_DATA_DIR falls back to ./data (local development), which is not the
  // production database.
  console.error(`database: ${DB_PATH}${process.env.SITE_DATA_DIR ? "" : "  (SITE_DATA_DIR unset: local development database)"}`);
  const db = openDb(DB_PATH);
  try {
    process.exitCode = run(db, process.argv.slice(2));
  } finally {
    db.close();
  }
}
