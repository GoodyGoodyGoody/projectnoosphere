// Submit the seed how-tos (seed/*.json) through the public API, as one honest
// contributor identity. Each file is sent with an Idempotency-Key derived from
// its name, so re-running never creates duplicates. They arrive as candidates
// and go through the librarian like everything else.
//
//   NOOSPHERE_API_BASE=http://127.0.0.1:3012 NOOSPHERE_SEED_TOKEN=nsp_… node scripts/seed.ts [--from 13]
//
// --from N skips files numbered below N. Replays are free of duplicates but not
// of rate limits (30 writes/hour per contributor), so send only the new ones.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function seedFiles(dir = join(import.meta.dirname, "..", "seed")) {
  return readdirSync(dir)
    .filter((f) => /^\d{2}-[a-z0-9-]+\.json$/.test(f))
    .sort()
    .map((f) => ({ name: f.replace(/\.json$/, ""), record: JSON.parse(readFileSync(join(dir, f), "utf8")) }));
}

if (import.meta.main) {
  const base = process.env.NOOSPHERE_API_BASE ?? "http://127.0.0.1:3012";
  const token = process.env.NOOSPHERE_SEED_TOKEN;
  if (!token) throw new Error("NOOSPHERE_SEED_TOKEN is not set");
  const fromArg = process.argv.indexOf("--from");
  const from = fromArg > 0 ? Number(process.argv[fromArg + 1]) : 0;
  if (!Number.isInteger(from) || from < 0) throw new Error("--from takes a file number, e.g. --from 13");
  let failed = 0;
  for (const { name, record } of seedFiles().filter((f) => Number(f.name.slice(0, 2)) >= from)) {
    const res = await fetch(`${base}/api/v1/records`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": `seed:${name}` },
      body: JSON.stringify(record),
    });
    const body = (await res.json()) as any;
    if (res.status === 201) {
      const flags = (body.gate?.flags ?? []).map((f: { code: string }) => f.code).join(",");
      console.log(`${name}: ${body.created_revision.id}${res.headers.get("idempotent-replayed") ? " (already submitted)" : ""}${flags ? ` flags: ${flags}` : ""}`);
    } else {
      failed++;
      console.error(`${name}: HTTP ${res.status} ${JSON.stringify(body.error)}`);
    }
  }
  process.exit(failed ? 1 : 0);
}
