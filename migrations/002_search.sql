-- 002_search: full-text search (FTS5) over the current published revision of
-- each record plus open candidates. Old reviewed revisions, quarantined,
-- rejected and superseded content are never in the index.
--
-- The FTS rowid is revisions.rowid, so removing an entry is a key lookup.
-- Triggers keep the index right no matter which code path changes state; the
-- search query ALSO re-checks state at read time, so a missed trigger cannot
-- leak withheld content.
--
-- bm25() weights are positional over ALL columns including UNINDEXED ones
-- (verified 2026-09-30): (visibility, title, summary, body, tags).

CREATE VIRTUAL TABLE revision_search USING fts5(
  visibility UNINDEXED,
  title,
  summary,
  body,
  tags,
  tokenize = 'porter unicode61'
);

-- The one rule, stated once and reused by every trigger below (SQLite triggers
-- cannot call a shared procedure, so the two statements are repeated verbatim):
--   indexed as 'candidate'  when review state is candidate
--   indexed as 'published'  when reviewed AND it is its record's current revision
--   otherwise not indexed

CREATE TRIGGER revision_search_on_review_insert
AFTER INSERT ON revision_review
BEGIN
  DELETE FROM revision_search WHERE rowid = (SELECT rowid FROM revisions WHERE id = NEW.revision_id);
  INSERT INTO revision_search (rowid, visibility, title, summary, body, tags)
  SELECT v.rowid, CASE rr.state WHEN 'candidate' THEN 'candidate' ELSE 'published' END,
         v.title, v.summary, v.body_markdown,
         coalesce((SELECT group_concat(value, ' ') FROM json_each(v.tags)), '')
    FROM revisions v
    JOIN revision_review rr ON rr.revision_id = v.id
    JOIN records r ON r.id = v.record_id
   WHERE v.id = NEW.revision_id
     AND (rr.state = 'candidate' OR (rr.state = 'reviewed' AND r.current_revision_id = v.id));
END;

CREATE TRIGGER revision_search_on_review_update
AFTER UPDATE ON revision_review
BEGIN
  DELETE FROM revision_search WHERE rowid = (SELECT rowid FROM revisions WHERE id = NEW.revision_id);
  INSERT INTO revision_search (rowid, visibility, title, summary, body, tags)
  SELECT v.rowid, CASE rr.state WHEN 'candidate' THEN 'candidate' ELSE 'published' END,
         v.title, v.summary, v.body_markdown,
         coalesce((SELECT group_concat(value, ' ') FROM json_each(v.tags)), '')
    FROM revisions v
    JOIN revision_review rr ON rr.revision_id = v.id
    JOIN records r ON r.id = v.record_id
   WHERE v.id = NEW.revision_id
     AND (rr.state = 'candidate' OR (rr.state = 'reviewed' AND r.current_revision_id = v.id));
END;

-- Publishing moves the pointer: the old current revision leaves the index and
-- the new one is re-evaluated (it becomes 'published' once its review state
-- flips to reviewed, which fires the trigger above).
CREATE TRIGGER revision_search_on_pointer_move
AFTER UPDATE OF current_revision_id ON records
BEGIN
  DELETE FROM revision_search WHERE rowid = (SELECT rowid FROM revisions WHERE id = OLD.current_revision_id);
  DELETE FROM revision_search WHERE rowid = (SELECT rowid FROM revisions WHERE id = NEW.current_revision_id);
  INSERT INTO revision_search (rowid, visibility, title, summary, body, tags)
  SELECT v.rowid, CASE rr.state WHEN 'candidate' THEN 'candidate' ELSE 'published' END,
         v.title, v.summary, v.body_markdown,
         coalesce((SELECT group_concat(value, ' ') FROM json_each(v.tags)), '')
    FROM revisions v
    JOIN revision_review rr ON rr.revision_id = v.id
    JOIN records r ON r.id = v.record_id
   WHERE v.id IN (OLD.current_revision_id, NEW.current_revision_id)
     AND (rr.state = 'candidate' OR (rr.state = 'reviewed' AND r.current_revision_id = v.id));
END;

-- Backfill everything that already qualifies.
INSERT INTO revision_search (rowid, visibility, title, summary, body, tags)
SELECT v.rowid, CASE rr.state WHEN 'candidate' THEN 'candidate' ELSE 'published' END,
       v.title, v.summary, v.body_markdown,
       coalesce((SELECT group_concat(value, ' ') FROM json_each(v.tags)), '')
  FROM revisions v
  JOIN revision_review rr ON rr.revision_id = v.id
  JOIN records r ON r.id = v.record_id
 WHERE rr.state = 'candidate' OR (rr.state = 'reviewed' AND r.current_revision_id = v.id);
