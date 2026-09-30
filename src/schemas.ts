import { ID_PATTERN } from "./ids.ts";

// Server-owned request schemas. Every object sets additionalProperties:false and
// the body validator runs with removeAdditional:false (see app.ts), so an
// unexpected field — including a spoofed author_id — is a 400 naming the field,
// not something silently dropped.
//
// Limits are the pilot defaults from the handoff; tune them from measurements.
export const LIMITS = {
  bodyBytes: 128 * 1024,
  title: 200,
  summary: 1000,
  bodyMarkdown: 100_000,
  tags: 20,
  sources: 50,
  links: 50,
  conditionKeys: 30,
  pageMax: 50,
  pageDefault: 20,
  annotationBody: 20_000,
  outcomeReportMinBody: 40,
} as const;

export const REVISION_KINDS = [
  "observation", "claim", "hypothesis", "procedure", "experiment_result", "synthesis",
] as const;
export const ANNOTATION_KINDS = [
  "critique", "question", "usefulness", "correction_note", "outcome_report",
] as const;
export const OUTCOMES = [
  "worked", "failed", "partially_worked", "not_applicable", "inconclusive",
] as const;
export const LINK_TYPES = ["supports", "contradicts", "supersedes", "related"] as const;

export type RevisionKind = (typeof REVISION_KINDS)[number];
export type AnnotationKind = (typeof ANNOTATION_KINDS)[number];
export type Outcome = (typeof OUTCOMES)[number];

export interface SourceRef {
  url?: string;
  revision_id?: string;
  title?: string;
  accessed_at?: string;
  note: string;
  license?: string;
}
export interface LinkRef {
  type: (typeof LINK_TYPES)[number];
  revision_id: string;
  note?: string;
}
export type Conditions = Record<string, string | number | boolean>;

export interface RevisionInput {
  kind: RevisionKind;
  title: string;
  summary: string;
  body_markdown: string;
  tags?: string[];
  sources?: SourceRef[];
  conditions?: Conditions;
  links?: LinkRef[];
}

export interface AnnotationInput {
  kind: AnnotationKind;
  outcome?: Outcome;
  body: string;
  evidence?: SourceRef[];
  conditions?: Conditions;
  supersedes_annotation_id?: string;
}

// A reference: exactly one of an external URL or an internal exact revision.
// Stored as given. The server never fetches URLs (no crawler, no SSRF surface).
const sourceRef = {
  type: "object",
  additionalProperties: false,
  required: ["note"],
  properties: {
    url: { type: "string", maxLength: 2000, pattern: "^https?://[^\\s]+$" },
    revision_id: { type: "string", pattern: ID_PATTERN.revision },
    title: { type: "string", minLength: 1, maxLength: 300 },
    accessed_at: { type: "string", minLength: 1, maxLength: 40 },
    note: { type: "string", minLength: 1, maxLength: 1000 },
    license: { type: "string", minLength: 1, maxLength: 100 },
  },
  oneOf: [{ required: ["url"] }, { required: ["revision_id"] }],
} as const;

const conditions = {
  type: "object",
  maxProperties: LIMITS.conditionKeys,
  propertyNames: { pattern: "^[a-z][a-z0-9_]{0,63}$" },
  additionalProperties: {
    anyOf: [
      { type: "string", maxLength: 1000 },
      { type: "number" },
      { type: "boolean" },
    ],
  },
} as const;

export const revisionInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "title", "summary", "body_markdown"],
  properties: {
    kind: { type: "string", enum: REVISION_KINDS },
    title: { type: "string", minLength: 3, maxLength: LIMITS.title },
    summary: { type: "string", minLength: 1, maxLength: LIMITS.summary },
    body_markdown: { type: "string", minLength: 1, maxLength: LIMITS.bodyMarkdown },
    tags: {
      type: "array",
      maxItems: LIMITS.tags,
      uniqueItems: true,
      items: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,49}$" },
    },
    sources: { type: "array", maxItems: LIMITS.sources, items: sourceRef },
    conditions,
    links: {
      type: "array",
      maxItems: LIMITS.links,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "revision_id"],
        properties: {
          type: { type: "string", enum: LINK_TYPES },
          revision_id: { type: "string", pattern: ID_PATTERN.revision },
          note: { type: "string", minLength: 1, maxLength: 1000 },
        },
      },
    },
  },
} as const;

export const annotationInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "body"],
  properties: {
    kind: { type: "string", enum: ANNOTATION_KINDS },
    outcome: { type: "string", enum: OUTCOMES },
    body: { type: "string", minLength: 1, maxLength: LIMITS.annotationBody },
    evidence: { type: "array", maxItems: LIMITS.sources, items: sourceRef },
    conditions,
    supersedes_annotation_id: { type: "string", pattern: ID_PATTERN.annotation },
  },
} as const;

export const pageQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: LIMITS.pageMax, default: LIMITS.pageDefault },
    cursor: { type: "string", maxLength: 40, pattern: "^[a-z]+_[0-9A-HJKMNP-TV-Z]{26}$" },
  },
} as const;

export const annotationListQuerySchema = {
  ...pageQuerySchema,
  properties: {
    ...pageQuerySchema.properties,
    include: { type: "string", enum: ["candidate"] },
  },
} as const;

export const params = {
  record: {
    type: "object",
    additionalProperties: false,
    required: ["record_id"],
    properties: { record_id: { type: "string", pattern: ID_PATTERN.record } },
  },
  revision: {
    type: "object",
    additionalProperties: false,
    required: ["revision_id"],
    properties: { revision_id: { type: "string", pattern: ID_PATTERN.revision } },
  },
} as const;

// A proposed revision: the revision fields plus the lineage the client assumed.
// base_revision_id is REQUIRED (null when the record has no published revision):
// the client must say which published version it edited, so a stale edit is a
// 409 instead of silently replacing newer work.
const nullableRevisionId = {
  anyOf: [{ type: "string", pattern: ID_PATTERN.revision }, { type: "null" }],
} as const;

export const proposalInputSchema = {
  ...revisionInputSchema,
  required: [...revisionInputSchema.required, "base_revision_id"],
  properties: {
    ...revisionInputSchema.properties,
    base_revision_id: nullableRevisionId,
    parent_revision_id: { type: "string", pattern: ID_PATTERN.revision },
  },
} as const;

export interface ProposalInput extends RevisionInput {
  base_revision_id: string | null;
  parent_revision_id?: string;
}

export const MODERATION_ACTIONS = ["publish_revision", "approve_annotation"] as const;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];

export const moderationInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action", "target_id", "reason"],
  properties: {
    action: { type: "string", enum: MODERATION_ACTIONS },
    target_id: { type: "string", pattern: "^(rev|ann)_[0-9A-HJKMNP-TV-Z]{26}$" },
    reason: { type: "string", minLength: 1, maxLength: 2000 },
  },
} as const;

export interface ModerationInput {
  action: ModerationAction;
  target_id: string;
  reason: string;
}

export const searchQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["q"],
  properties: {
    q: { type: "string", minLength: 1, maxLength: 200 },
    limit: { type: "integer", minimum: 1, maximum: LIMITS.pageMax, default: 10 },
    offset: { type: "integer", minimum: 0, maximum: 1000, default: 0 },
    include: { type: "string", enum: ["candidate"] },
  },
} as const;

// The HTML search page: q optional (no q → just the form).
export const searchPageQuerySchema = {
  ...searchQuerySchema,
  required: [],
} as const;

export const recordListQuerySchema = pageQuerySchema;
