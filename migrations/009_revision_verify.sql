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
    OR length(trim(json_extract(NEW.verify_json, '$.run'), ' '||char(9)||char(10)||char(13))) < 1
    OR length(json_extract(NEW.verify_json, '$.run')) > 2000
    OR length(trim(json_extract(NEW.verify_json, '$.expect'), ' '||char(9)||char(10)||char(13))) < 1
    OR length(json_extract(NEW.verify_json, '$.expect')) > 4000
    THEN RAISE(ABORT, 'invalid revision verify') END;
  -- Normalize spelling/punctuation before comparing bare-success phrases.
  WITH normalized(value) AS (
    SELECT lower(replace(replace(replace(replace(replace(replace(
      trim(json_extract(NEW.verify_json, '$.expect'), char(9)||char(10)||char(13)||' '||char(34)||char(39)||'`.!'),
      ' ', ''), char(9), ''), char(10), ''), char(13), ''), ':', ''), '=', ''))
  ), bare(value) AS (
    SELECT verb || connector || label || '0'
      FROM (SELECT 'exit' AS verb UNION ALL SELECT 'exited' UNION ALL SELECT 'return' UNION ALL SELECT 'returned'
            UNION ALL SELECT 'rc' UNION ALL SELECT 'status' UNION ALL SELECT 'code')
      CROSS JOIN (SELECT '' AS connector UNION ALL SELECT 'with')
      CROSS JOIN (SELECT '' AS label UNION ALL SELECT 'code' UNION ALL SELECT 'status')
    UNION ALL SELECT value FROM json_each('["0","ok","okay","success","successful","succeeded","pass","passed","done","works","worked","itworked","fine","noerror","noerrors"]')
  )
  SELECT CASE WHEN (SELECT value FROM normalized) IN (SELECT value FROM bare)
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
    OR length(trim(json_extract(NEW.check_json, '$.ran'), ' '||char(9)||char(10)||char(13))) < 1
    OR length(json_extract(NEW.check_json, '$.ran')) > 2000
    OR length(trim(json_extract(NEW.check_json, '$.observed'), ' '||char(9)||char(10)||char(13))) < 1
    OR length(json_extract(NEW.check_json, '$.observed')) > 4000
    THEN RAISE(ABORT, 'invalid stated outcome check') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM revisions WHERE id = NEW.revision_id AND verify_json IS NOT NULL
  ) THEN RAISE(ABORT, 'check.stated requires revision verify') END;
  WITH normalized(value) AS (
    SELECT lower(replace(replace(replace(replace(replace(replace(
      trim(json_extract(NEW.check_json, '$.observed'), char(9)||char(10)||char(13)||' '||char(34)||char(39)||'`.!'),
      ' ', ''), char(9), ''), char(10), ''), char(13), ''), ':', ''), '=', ''))
  ), bare(value) AS (
    SELECT verb || connector || label || '0'
      FROM (SELECT 'exit' AS verb UNION ALL SELECT 'exited' UNION ALL SELECT 'return' UNION ALL SELECT 'returned'
            UNION ALL SELECT 'rc' UNION ALL SELECT 'status' UNION ALL SELECT 'code')
      CROSS JOIN (SELECT '' AS connector UNION ALL SELECT 'with')
      CROSS JOIN (SELECT '' AS label UNION ALL SELECT 'code' UNION ALL SELECT 'status')
    UNION ALL SELECT value FROM json_each('["0","ok","okay","success","successful","succeeded","pass","passed","done","works","worked","itworked","fine","noerror","noerrors"]')
  )
  SELECT CASE WHEN (SELECT value FROM normalized) IN (SELECT value FROM bare)
    THEN RAISE(ABORT, 'check.observed needs an observable result') END;
END;
