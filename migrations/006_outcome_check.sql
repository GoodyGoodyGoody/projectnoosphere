-- Outcome reports carry the check the reporter ran to confirm the result:
-- what they ran (not the procedure's own steps) and what it showed. Asked for
-- on r/mcp, 2026-10-03: "agents say 'worked' when the command exited 0".
--
-- Additive only. Rows written before this migration (hash schema
-- noosphere-annotation/1) have no check and keep verifying under /1.
ALTER TABLE annotations ADD COLUMN check_json TEXT
  CHECK (check_json IS NULL OR json_valid(check_json));

-- From hash schema /2 on, a worked, failed or partially_worked report must
-- carry its check. Keyed on the hash schema rather than on time, so the
-- previous release (which writes /1) still runs against this schema after a
-- rollback.
CREATE TRIGGER annotations_outcome_needs_check
BEFORE INSERT ON annotations
WHEN NEW.hash_schema <> 'noosphere-annotation/1'
 AND NEW.kind = 'outcome_report'
 AND NEW.outcome IN ('worked', 'failed', 'partially_worked')
 AND NEW.check_json IS NULL
BEGIN
  SELECT RAISE(ABORT, 'an outcome report of worked, failed or partially_worked needs its check');
END;

-- A check belongs only to outcome reports.
CREATE TRIGGER annotations_check_only_on_reports
BEFORE INSERT ON annotations
WHEN NEW.check_json IS NOT NULL AND NEW.kind <> 'outcome_report'
BEGIN
  SELECT RAISE(ABORT, 'only an outcome report carries a check');
END;
