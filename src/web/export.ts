import { getRevision, noticeFor } from "../modules/records.ts";
import type { DB } from "../db.ts";

// A revision as a standalone Markdown document for generic HTTP clients.
// Every front-matter value is JSON-encoded (valid YAML flow scalars), so no
// contributed title or tag can inject a line of fake metadata.
export function revisionMarkdown(db: DB, revisionId: string, publicOrigin: string): string {
  const { revision: rev } = getRevision(db, revisionId);
  const fm = (fields: Record<string, unknown>) =>
    "---\n" +
    Object.entries(fields)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join("\n") +
    "\n---\n";
  if ("withheld" in rev) {
    return fm({
      revision_id: rev.id,
      record_id: rev.record_id,
      review_state: rev.review_state,
      withheld: true,
      withheld_reason: rev.withheld_reason,
    }) + "\nThis revision has been quarantined and its content is withheld.\n";
  }
  const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
  return (
    fm({
      revision_id: rev.id,
      record_id: rev.record_id,
      record_slug: rev.record_slug,
      review_state: rev.review_state,
      is_current_published: rev.is_current_published,
      current_revision_id: rev.current_revision_id,
      kind: rev.kind,
      title: rev.title,
      author_id: rev.author_id,
      author_display_name: rev.author_display_name,
      created_at: rev.created_at,
      base_revision_id: rev.base_revision_id,
      content_hash: rev.content_hash,
      hash_schema: rev.hash_schema,
      content_license: rev.content_license,
      tags: rev.tags,
      conditions: rev.conditions,
      sources: rev.sources,
      links: rev.links,
      html_url: `${publicOrigin}/r/${rev.record_slug}/revisions/${rev.id}`,
      notice: noticeFor(rev.review_state),
    }) +
    `\n# ${oneLine(rev.title)}\n\n> ${oneLine(rev.summary)}\n\n${rev.body_markdown}\n`
  );
}
