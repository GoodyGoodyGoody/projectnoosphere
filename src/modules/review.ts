import type { DB } from "../db.ts";
import type { GateFlag } from "../gate.ts";
import { annotationView } from "./annotations.ts";
import { getRevision, getRevisionSummaries } from "./records.ts";

// The librarian's inbox: open candidates it has not yet decided under this
// rubric version, oldest first, with full content, gate flags, and the context
// a reviewer needs. Quarantined items never appear (and credentials never got
// stored at all). Steward-only.
//
// Everything returned is untrusted contributor text. The worker must present
// it to models as data, one item per call.
export function reviewQueue(db: DB, opts: { rubricVersion: string; limit: number }) {
  const notYetDecided = `NOT EXISTS (SELECT 1 FROM moderation_events m
                                      WHERE m.target_id = x.id AND m.rubric_version = ?)`;
  const revRows = db
    .prepare(
      `SELECT x.id, rr.gate_flags, r.current_revision_id, x.base_revision_id
         FROM revisions x
         JOIN revision_review rr ON rr.revision_id = x.id
         JOIN records r ON r.id = x.record_id
        WHERE rr.state = 'candidate' AND ${notYetDecided}
        ORDER BY x.id LIMIT ?`,
    )
    .all(opts.rubricVersion, opts.limit) as {
    id: string;
    gate_flags: string;
    current_revision_id: string | null;
    base_revision_id: string | null;
  }[];

  const revisions = revRows.map((r) => {
    const { revision } = getRevision(db, r.id);
    const current = r.current_revision_id ? getRevisionSummaries(db, [r.current_revision_id])[0] ?? null : null;
    return {
      revision,
      gate_flags: JSON.parse(r.gate_flags) as GateFlag[],
      // A stale base means this candidate lost a race: it is superseded by
      // code, never judged by a model.
      base_is_stale: r.current_revision_id !== r.base_revision_id,
      current_published: current,
    };
  });

  const annRows = db
    .prepare(
      `SELECT x.id, ar.gate_flags FROM annotations x
         JOIN annotation_review ar ON ar.annotation_id = x.id
        WHERE ar.state = 'candidate' AND ${notYetDecided}
        ORDER BY x.id LIMIT ?`,
    )
    .all(opts.rubricVersion, opts.limit) as { id: string; gate_flags: string }[];

  const annotations = annRows.map((a) => {
    const row = db
      .prepare(
        `SELECT a.*, p.display_name AS author_display_name, ar.state AS review_state
           FROM annotations a JOIN contributors p ON p.id = a.author_id
           JOIN annotation_review ar ON ar.annotation_id = a.id WHERE a.id = ?`,
      )
      .get(a.id) as Parameters<typeof annotationView>[0];
    const annotation = annotationView(row);
    const target = getRevisionSummaries(db, [annotation.revision_id])[0] ?? null;
    return { annotation, gate_flags: JSON.parse(a.gate_flags) as GateFlag[], target_revision: target };
  });

  return { rubric_version: opts.rubricVersion, revisions, annotations };
}
