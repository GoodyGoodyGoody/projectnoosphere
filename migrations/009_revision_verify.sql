-- Additive: old code writes revision /1 and annotation /2, untouched by these guards.
ALTER TABLE revisions ADD COLUMN verify_json TEXT
  CHECK (verify_json IS NULL OR json_valid(verify_json));

CREATE TRIGGER revisions_verify_shape
BEFORE INSERT ON revisions
WHEN NEW.hash_schema = 'noosphere-revision/2'
BEGIN
  SELECT CASE WHEN NEW.verify_json IS NULL OR NOT json_valid(NEW.verify_json)
    THEN RAISE(ABORT, 'revision /2 needs verify') END;
  SELECT CASE WHEN json_type(NEW.verify_json) <> 'object'
    OR (SELECT count(*) FROM json_each(NEW.verify_json)) <> 2
    OR json_type(NEW.verify_json, '$.run') IS NOT 'text'
    OR json_type(NEW.verify_json, '$.expect') IS NOT 'text'
    OR length(trim(json_extract(NEW.verify_json, '$.run'))) < 1
    OR length(json_extract(NEW.verify_json, '$.run')) > 2000
    OR length(trim(json_extract(NEW.verify_json, '$.expect'))) < 1
    OR length(json_extract(NEW.verify_json, '$.expect')) > 4000
    THEN RAISE(ABORT, 'invalid revision verify') END;
  SELECT CASE WHEN lower(trim(json_extract(NEW.verify_json, '$.expect'), char(9)||char(10)||char(13)||' '||char(34)||char(39)||'`.!'))
    IN ('0', 'ok', 'okay', 'success', 'successful', 'succeeded', 'pass', 'passed', 'done',
        'works', 'worked', 'it worked', 'fine', 'no error', 'no errors',
        'exit 0', 'exit code 0', 'exit status 0', 'exit status: 0', 'exited 0',
        'exited with code 0', 'exited with status 0', 'returned 0', 'return 0', 'rc=0', 'rc:0', 'status 0', 'code 0')
    THEN RAISE(ABORT, 'verify.expect needs an observable result') END;
END;

CREATE TRIGGER annotations_stated_shape
BEFORE INSERT ON annotations
WHEN NEW.hash_schema = 'noosphere-annotation/3'
BEGIN
  SELECT CASE WHEN NEW.kind <> 'outcome_report' OR NEW.check_json IS NULL
    THEN RAISE(ABORT, 'annotation /3 needs a stated outcome check') END;
  SELECT CASE WHEN json_type(NEW.check_json) <> 'object'
    OR (SELECT count(*) FROM json_each(NEW.check_json)) <> 3
    OR json_type(NEW.check_json, '$.ran') IS NOT 'text'
    OR json_type(NEW.check_json, '$.observed') IS NOT 'text'
    OR json_type(NEW.check_json, '$.stated') NOT IN ('true', 'false')
    OR json_type(NEW.check_json, '$.stated') IS NULL
    OR length(trim(json_extract(NEW.check_json, '$.ran'))) < 1
    OR length(json_extract(NEW.check_json, '$.ran')) > 2000
    OR length(trim(json_extract(NEW.check_json, '$.observed'))) < 1
    OR length(json_extract(NEW.check_json, '$.observed')) > 4000
    THEN RAISE(ABORT, 'invalid stated outcome check') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM revisions WHERE id = NEW.revision_id AND verify_json IS NOT NULL
  ) THEN RAISE(ABORT, 'check.stated requires revision verify') END;
END;
