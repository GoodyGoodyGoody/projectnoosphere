-- 004_librarian_plumbing: what the librarian (ADR 0005) needs, plus the fix for
-- slugs outliving quarantine (ROADMAP "Known issue: slugs").

-- ---- slugs are minted at first publication ---------------------------------
-- A record's public address used to be minted from its first, UNREVIEWED
-- title. Now a new record's slug is provisional (its own id, lowercased) until
-- a revision is first published; then the slug is minted once from the
-- reviewed title and never changes again. Additive on purpose: SQLite ignores
-- PRAGMA foreign_keys inside this migration's transaction, so no table rebuild.
ALTER TABLE records ADD COLUMN slug_minted_at TEXT;

DROP TRIGGER records_identity_immutable;

-- Existing data: published records keep the slug they have; unpublished ones
-- fall back to a provisional slug until they are published.
UPDATE records SET slug_minted_at = created_at WHERE current_revision_id IS NOT NULL;
UPDATE records SET slug = lower(id) WHERE current_revision_id IS NULL;

-- Identity stays immutable, with exactly one allowed change: the single
-- mint (slug_minted_at NULL → set, slug changing in the same update).
CREATE TRIGGER records_identity_immutable
BEFORE UPDATE ON records
WHEN NEW.id IS NOT OLD.id
  OR NEW.created_by IS NOT OLD.created_by
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.slug_minted_at IS NOT NULL AND NEW.slug_minted_at IS NOT OLD.slug_minted_at)
  OR (NEW.slug IS NOT OLD.slug AND NOT (OLD.slug_minted_at IS NULL AND NEW.slug_minted_at IS NOT NULL))
BEGIN
  SELECT RAISE(ABORT, 'record identity is immutable');
END;

-- ---- the submission gate ---------------------------------------------------
-- Deterministic findings recorded at submission (injection-like phrasing,
-- possible personal data, duplicates). Flags inform review; they never decide
-- it. Credentials are not flagged here: a submission containing one is refused
-- outright and never stored.
ALTER TABLE revision_review ADD COLUMN gate_flags TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(gate_flags) AND json_type(gate_flags) = 'array');
ALTER TABLE annotation_review ADD COLUMN gate_flags TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(gate_flags) AND json_type(gate_flags) = 'array');

-- ---- moderation events carry the rubric version ------------------------------
-- Candidates are immutable, so an item reviewed under a rubric version is not
-- re-reviewed (and re-billed, and possibly flipped) under the same version.
ALTER TABLE moderation_events ADD COLUMN rubric_version TEXT;
CREATE INDEX moderation_events_rubric ON moderation_events(target_id, rubric_version);
