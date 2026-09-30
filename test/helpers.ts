import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type AppOptions } from "../src/app.ts";
import { migrate, openDb } from "../src/db.ts";
import { createContributor } from "../src/modules/contributors.ts";
import type { AnnotationInput, RevisionInput } from "../src/schemas.ts";

// A fresh database file per test context: real SQLite, real triggers, WAL on.
export const TEST_ORIGIN = "https://noosphere.test";

// Generous limits by default so ordinary tests never trip them by accident;
// the limit tests pass their own small numbers.
export const ROOMY_LIMITS = {
  registrationPerIpPerHour: 1e6, registrationPerIpPerDay: 1e6, registrationGlobalPerDay: 1e6,
  writesPerContributorPerHour: 1e6, writesPerContributorPerDay: 1e6, writesPerIpPerHour: 1e6, writesGlobalPerDay: 1e6,
};

export function setup(extra: Partial<Omit<AppOptions, "db">> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "noosphere-test-"));
  const db = openDb(join(dir, "test.sqlite"));
  migrate(db);
  const mk = (name: string) => {
    const c = createContributor(db, { displayName: name });
    return { id: c.contributorId, token: c.credential.token, prefix: c.credential.tokenPrefix };
  };
  const a = mk("Agent A");
  const b = mk("Agent B");
  const st = createContributor(db, { displayName: "Steward", role: "steward" });
  const s = { id: st.contributorId, token: st.credential.token, prefix: st.credential.tokenPrefix };
  const app = buildApp({ db, publicOrigin: TEST_ORIGIN, limits: ROOMY_LIMITS, ...extra });
  return {
    app,
    db,
    a,
    b,
    s,
    dir,
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

// The steward publishes a candidate through the moderation endpoint.
export async function publish(app: ReturnType<typeof setup>["app"], stewardToken: string, revisionId: string) {
  return app.inject({
    method: "POST",
    url: "/api/v1/admin/moderation-events",
    headers: bearer(stewardToken),
    payload: { action: "publish_revision", target_id: revisionId, reason: "test publish" },
  });
}

export async function propose(
  app: ReturnType<typeof setup>["app"],
  token: string,
  recordId: string,
  base: string | null,
  overrides: Partial<RevisionInput> = {},
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/records/${recordId}/revisions`,
    headers: bearer(token),
    payload: { ...sampleRecord(overrides), base_revision_id: base },
  });
}

// Create + publish in one step; returns ids and the permanent slug.
export async function publishedRecord(
  t: ReturnType<typeof setup>,
  token: string,
  overrides: Partial<RevisionInput> = {},
) {
  const { recordId, revisionId, json } = await createRecordAs(t.app, token, sampleRecord(overrides));
  const res = await publish(t.app, t.s.token, revisionId);
  if (res.statusCode !== 201) throw new Error(`publish failed ${res.statusCode}: ${res.body}`);
  return { recordId, revisionId, slug: json.record.slug as string };
}
