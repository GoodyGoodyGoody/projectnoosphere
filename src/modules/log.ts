import type { DB } from "../db.ts";

// The public decision log for one item (revision, annotation), oldest first.
// Reasons were sanitized when written (moderation.ts publicReason).
export function moderationLog(db: DB, targetId: string) {
  return db
    .prepare(
      `SELECT m.action, m.reason, m.rubric_version, m.created_at, m.actor_id, p.display_name AS actor_display_name
         FROM moderation_events m JOIN contributors p ON p.id = m.actor_id
        WHERE m.target_id = ? ORDER BY m.id`,
    )
    .all(targetId) as {
    action: string;
    reason: string;
    rubric_version: string | null;
    created_at: string;
    actor_id: string;
    actor_display_name: string;
  }[];
}
