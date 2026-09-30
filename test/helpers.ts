import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.ts";
import { migrate, openDb } from "../src/db.ts";
import { createContributor } from "../src/modules/contributors.ts";
import type { AnnotationInput, RevisionInput } from "../src/schemas.ts";

// A fresh database file per test context: real SQLite, real triggers, WAL on.
export function setup() {
  const dir = mkdtempSync(join(tmpdir(), "noosphere-test-"));
  const db = openDb(join(dir, "test.sqlite"));
  migrate(db);
  const mk = (name: string) => {
    const c = createContributor(db, { displayName: name });
    return { id: c.contributorId, token: c.credential.token, prefix: c.credential.tokenPrefix };
  };
  const a = mk("Agent A");
  const b = mk("Agent B");
  const app = buildApp({ db });
  return {
    app,
    db,
    a,
    b,
    async close() {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export function sampleRecord(overrides: Partial<RevisionInput> = {}): RevisionInput {
  return {
    kind: "procedure",
    title: "Report an outcome against an exact Noosphere revision",
    summary: "Retrieve a fixed revision before testing and attach the report to that revision.",
    body_markdown: "1. GET the revision by id.\n2. Test it.\n3. POST an outcome_report to that revision.",
    tags: ["noosphere", "revision-history"],
    sources: [],
    conditions: { api_version: "v1", limitations: "Documents the client workflow only." },
    ...overrides,
  };
}

export function sampleOutcome(overrides: Partial<AnnotationInput> = {}): AnnotationInput {
  return {
    kind: "outcome_report",
    outcome: "worked",
    body: "Fetched the exact revision by id, followed steps 1-3, and the report attached to it.",
    conditions: { client: "node 24.19.0 fetch", tested: "2026-09-30" },
    ...overrides,
  };
}

export async function createRecordAs(
  app: ReturnType<typeof setup>["app"],
  token: string,
  body: RevisionInput = sampleRecord(),
) {
  const res = await app.inject({ method: "POST", url: "/api/v1/records", headers: bearer(token), payload: body });
  if (res.statusCode !== 201) throw new Error(`create failed ${res.statusCode}: ${res.body}`);
  const json = res.json();
  return { recordId: json.record.id as string, revisionId: json.created_revision.id as string, json };
}

export function count(db: ReturnType<typeof setup>["db"], table: string): number {
  return db.prepare(`SELECT count(*) FROM ${table}`).pluck().get() as number;
}
