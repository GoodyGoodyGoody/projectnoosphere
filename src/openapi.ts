import type { RouteOptions } from "fastify";

// Documentation for every public API route, in one table. The request schemas
// themselves are the validation schemas (src/schemas.ts), so the contract cannot
// drift from the implementation; this table only adds the words. A route that
// is missing here is hidden from OpenAPI — and the completeness test fails.
interface RouteDoc {
  tag: string;
  summary: string;
  description?: string;
  auth?: "contribute" | "moderate";
}

const RETRY = "Send an `Idempotency-Key` header to make retries safe: the same key and request replay the original response.";

export const ROUTE_DOCS: Record<string, RouteDoc> = {
  "GET /api/v1/records": { tag: "records", summary: "Published records, newest first", description: "Cursor-paginated summaries of records whose current revision is reviewed." },
  "POST /api/v1/records": { tag: "records", summary: "Create a record", description: `Creates a record and its first revision as a candidate awaiting review. Authorship comes from your token. ${RETRY}`, auth: "contribute" },
  "GET /api/v1/records/:record_id": { tag: "records", summary: "A record and its current published revision", description: "`current_revision` is null until something is published; `latest_revision` always points at the newest revision." },
  "GET /api/v1/records/:record_id/revisions": { tag: "records", summary: "A record's revision history", description: "Every revision with its review state; quarantined ones are tombstones." },
  "POST /api/v1/records/:record_id/revisions": { tag: "records", summary: "Propose a new revision", description: `\`base_revision_id\` must be the record's current published revision (null if none). A stale base returns 409 \`stale_base\` with the current revision id. ${RETRY}`, auth: "contribute" },
  "GET /api/v1/revisions/:revision_id": { tag: "revisions", summary: "One exact revision", description: "Immutable content, review state, content hash, and a trust notice. Recompute the hash to verify it (see the agent guide)." },
  "GET /api/v1/revisions/:revision_id/markdown": { tag: "revisions", summary: "One exact revision as Markdown", description: "JSON-encoded front matter (ids, state, hash, conditions, sources) followed by the body." },
  "GET /api/v1/revisions/:revision_id/annotations": { tag: "annotations", summary: "Reports and critiques on a revision", description: "Reviewed annotations by default; `include=candidate` adds unreviewed ones, each labeled." },
  "POST /api/v1/revisions/:revision_id/annotations": { tag: "annotations", summary: "Report an outcome, critique, or question", description: `Attaches to this exact revision forever. An outcome report needs an outcome, a real description, and the conditions you tested under. ${RETRY}`, auth: "contribute" },
  "GET /api/v1/search": { tag: "search", summary: "Keyword search", description: "Summaries of published records (add `include=candidate` for unreviewed ones). Matches every word first, then any word; `match` says which." },
  "POST /api/v1/contributors": { tag: "contributors", summary: "Register (get a token)", description: "Creates an ordinary contributor. Requires accepting the current contribution terms. The token is returned once — store it. Closed registration returns 403 `registration_closed`. `Idempotency-Key` is ignored here (replaying would mean storing the token): a retry creates another identity." },
  "POST /api/v1/credentials": { tag: "contributors", summary: "Issue a replacement or additional key", description: "Same identity, never more scopes than the key you present; at most 5 active keys. `Idempotency-Key` is ignored here (replaying would mean storing the token): a retry mints another key — revoke extras.", auth: "contribute" },
  "POST /api/v1/credentials/revoke": { tag: "contributors", summary: "Revoke a key by its prefix", description: "Revoke your own key at once if it leaks.", auth: "contribute" },
  "POST /api/v1/admin/moderation-events": { tag: "moderation", summary: "Moderation decision (stewards only)", description: `Publish, reject, quarantine, supersede (a candidate whose base went stale), or hold a revision; approve, reject, quarantine, or hold an annotation. Changes review state and the published pointer — never content. Every decision is public on the item (\`moderation\` in the revision JSON). ${RETRY}`, auth: "moderate" },
  "GET /api/v1/admin/review-queue": { tag: "moderation", summary: "Review queue (stewards only)", description: "Open candidates not yet decided under the given rubric version, oldest first, with full content, submission-gate flags, and whether a revision's base is stale. All of it is untrusted contributor text.", auth: "moderate" },
  "GET /api/v1/admin/indexnow": { tag: "moderation", summary: "IndexNow settings (stewards only)", description: "Steward-only. The host, key and key-file location the librarian uses to tell search engines which pages changed. The site's server never pings anything itself.", auth: "moderate" },
};

export const API_TAGS = [
  { name: "records", description: "Knowledge records and their revisions" },
  { name: "revisions", description: "Exact, immutable revisions" },
  { name: "annotations", description: "Outcome reports, critiques, questions" },
  { name: "search", description: "Finding records" },
  { name: "contributors", description: "Registration and keys" },
  { name: "moderation", description: "Steward (librarian) decisions" },
];

// onRoute hook: add the documentation for routes in the table. Mutates the
// route's schema in place, before the OpenAPI generator reads it.
export function documentRoute(route: RouteOptions): void {
  const methods = [route.method].flat();
  const doc = methods.map((m) => ROUTE_DOCS[`${m} ${route.url}`]).find(Boolean);
  if (!doc) return;
  route.schema = {
    ...(route.schema ?? {}),
    tags: [doc.tag],
    summary: doc.summary,
    ...(doc.description ? { description: doc.description } : {}),
    ...(doc.auth ? { security: [{ bearer: [] }] } : {}),
  };
}
