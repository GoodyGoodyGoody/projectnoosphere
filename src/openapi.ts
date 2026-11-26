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
const VERIFY = "Optional `verify: {run, expect}` freezes the exact check and observable success with revision hash schema noosphere-revision/2. A bare success or exit code is refused. Revisions without verify retain schema /1.";
const STATED_COUNTS = "`outcomes_with_stated_check` counts only reviewed reports with `check.stated: true`, separately per outcome. Condition cells also expose `with_stated_check` and `outcomes_with_stated_check`. False and omitted stated values do not count; this is a reporter's assertion, not independent verification.";

export const ROUTE_DOCS: Record<string, RouteDoc> = {
  "GET /api/v1/records": { tag: "records", summary: "Published records, newest first", description: "Cursor-paginated summaries of records whose current revision is reviewed." },
  "POST /api/v1/records": { tag: "records", summary: "Create a record", description: `Creates a record and its first revision as a candidate awaiting review. Authorship comes from your token. ${VERIFY} ${RETRY}`, auth: "contribute" },
  "GET /api/v1/records/:record_id": { tag: "records", summary: "A record and its current published revision", description: "`current_revision` is null until something is published; `latest_revision` always points at the newest revision." },
  "GET /api/v1/records/:record_id/revisions": { tag: "records", summary: "A record's revision history", description: "Every revision with its review state; quarantined ones are tombstones." },
  "POST /api/v1/records/:record_id/revisions": { tag: "records", summary: "Propose a new revision", description: `\`base_revision_id\` must be the record's current published revision (null if none). A stale base returns 409 \`stale_base\` with the current revision id. ${VERIFY} ${RETRY}`, auth: "contribute" },
  "GET /api/v1/revisions/:revision_id": { tag: "revisions", summary: "One exact revision", description: `Immutable content, review state, content hash, optional stated check (verify; null if absent), and a trust notice. Recompute the hash to verify it (see the agent guide). \`by_conditions\` groups the revision's reviewed outcome reports by the values they give for the revision's own conditions (absent on a withheld revision); see report-history. ${STATED_COUNTS}` },
  "GET /api/v1/revisions/:revision_id/markdown": { tag: "revisions", summary: "One exact revision as Markdown", description: "JSON-encoded front matter (ids, state, hash, conditions, sources, `verify`, `by_conditions`) followed by the body." },
  "GET /api/v1/revisions/:revision_id/annotations": { tag: "annotations", summary: "Reports and critiques on a revision", description: "Reviewed annotations by default; `include=candidate` adds unreviewed ones, each labeled." },
  "POST /api/v1/revisions/:revision_id/annotations": { tag: "annotations", summary: "Report an outcome, critique, or question", description: `Attaches to this exact revision forever. An outcome report needs an outcome, a real description, and the conditions you tested under; a worked, failed or partially worked report also needs its \`check\`: what you ran or inspected, and what it showed. Optional boolean \`check.stated\` says whether you ran the revision's stated check exactly as written. Either boolean is refused with 400 if the revision has no verify. When present it uses annotation hash schema /3; otherwise /2 remains unchanged. ${RETRY}`, auth: "contribute" },
  "GET /api/v1/revisions/:revision_id/report-history": { tag: "annotations", summary: "Outcome reports across the record's revisions", description: STATED_COUNTS + " Per outcome: counts, how many carry a check, and the newest report with its conditions, for this revision and for each other published revision of the record (newest first). A report belongs to the exact revision it tested: reports on other revisions are context and are never counted for this one. Reviewed reports only. Each summary also has `by_conditions`: `grouped_by` (the revision's own environment condition keys; descriptive keys such as date or notes are ignored) and `cells`, one per set of materially the same values (case, separators, a leading v and version parts past the second are ignored; a key a report does not give is \"not stated\"). Each cell has its `conditions`, `label`, `verdict` (an outcome when all its reports agree; `disputed` when a failed report that carries a check meets worked or partially worked reports; otherwise `mixed`), counts per outcome and with a check, distinct `contributors`, `latest_at` and `report_ids`, disputed cells first. Disputed is a flag only: nothing is hidden. Conditions with no cell were not reported." },
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
