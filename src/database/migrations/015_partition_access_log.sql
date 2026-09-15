-- Phase 20 (A12 #23) — partition access_log by month so the retention sweep
-- can DROP TABLE a fully-expired month instead of a bloat-causing row-by-row
-- DELETE. Idempotent (checks pg_partitioned_table first) and safe to run
-- against an empty or already-populated table: existing rows are copied into
-- the new partitioned table, a DEFAULT partition catches anything outside the
-- initial explicit-month range (old test fixtures, a data quirk), and the
-- id sequence is advanced past whatever was copied so new rows can't collide
-- with a copied id.
--
-- Ongoing partition creation/cleanup is src/db/partitions.ts, run monthly by
-- a pg-boss schedule (src/jobs/partitionMaintenance.ts).

DO $$
DECLARE
  already_partitioned boolean;
  d date;
  first_month date;
  last_month date;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_partitioned_table pt
    JOIN pg_class c ON c.oid = pt.partrelid
    WHERE c.relname = 'access_log'
  ) INTO already_partitioned;

  IF already_partitioned THEN
    RETURN;
  END IF;

  ALTER TABLE access_log RENAME TO access_log_pre_partition;
  ALTER SEQUENCE access_log_id_seq RENAME TO access_log_pre_partition_id_seq;

  CREATE TABLE access_log (
    id           BIGSERIAL NOT NULL,
    kennel_id    VARCHAR(255) NOT NULL,
    user_id      UUID,
    action       VARCHAR(40) NOT NULL,
    subject_type VARCHAR(20),
    subject_id   VARCHAR(255),
    ip           VARCHAR(64),
    detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
    at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, at)
  ) PARTITION BY RANGE (at);

  SELECT date_trunc('month', COALESCE(MIN(at), NOW()))::date,
         (date_trunc('month', NOW()) + INTERVAL '2 months')::date
    INTO first_month, last_month
    FROM access_log_pre_partition;

  d := first_month;
  WHILE d <= last_month LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF access_log FOR VALUES FROM (%L) TO (%L)',
      'access_log_' || to_char(d, 'YYYY_MM'), d, d + INTERVAL '1 month'
    );
    d := d + INTERVAL '1 month';
  END LOOP;

  -- catches anything older than first_month (a data quirk, or a historical
  -- test/seed row) so an insert can never fail for lack of a partition.
  CREATE TABLE IF NOT EXISTS access_log_default PARTITION OF access_log DEFAULT;

  INSERT INTO access_log SELECT * FROM access_log_pre_partition;
  PERFORM setval('access_log_id_seq', COALESCE((SELECT MAX(id) FROM access_log), 1));

  DROP TABLE access_log_pre_partition;
END $$;

CREATE INDEX IF NOT EXISTS access_log_kennel_idx  ON access_log (kennel_id, at DESC);
CREATE INDEX IF NOT EXISTS access_log_subject_idx ON access_log (subject_type, subject_id);
