import { createHash } from "node:crypto";

// Canonical JSON: object keys sorted by UTF-16 code unit (JavaScript's default
// sort), no insignificant whitespace, strings and finite numbers serialized by
// JSON.stringify. For the JSON types Noosphere accepts this matches RFC 8785
// (JCS), so an independent client can recompute a hash without this code.
//
// A content hash detects change. It is not a signature and not evidence that
// the content is true.
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("non-finite number in canonical JSON");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`cannot canonicalize ${typeof value}`);
  }
}

export function sha256(text: string): string {
  return "sha256:" + createHash("sha256").update(text, "utf8").digest("hex");
}

export const REVISION_HASH_SCHEMA = "noosphere-revision/1";
export const ANNOTATION_HASH_SCHEMA = "noosphere-annotation/1";

// Every immutable field of a revision. Moderation state is deliberately absent:
// review decisions change; content does not.
export interface RevisionHashInput {
  id: string;
  record_id: string;
  base_revision_id: string | null;
  parent_revision_id: string | null;
  author_id: string;
  kind: string;
  title: string;
  summary: string;
  body_markdown: string;
  tags: unknown[];
  sources: unknown[];
  conditions: Record<string, unknown>;
  links: unknown[];
  content_license: string;
  created_at: string;
}

export function revisionHash(r: RevisionHashInput): string {
  return sha256(canonicalJson({ schema: REVISION_HASH_SCHEMA, ...r }));
}

export interface AnnotationHashInput {
  id: string;
  revision_id: string;
  author_id: string;
  kind: string;
  outcome: string | null;
  body: string;
  evidence: unknown[];
  conditions: Record<string, unknown>;
  supersedes_annotation_id: string | null;
  created_at: string;
}

export function annotationHash(a: AnnotationHashInput): string {
  return sha256(canonicalJson({ schema: ANNOTATION_HASH_SCHEMA, ...a }));
}
