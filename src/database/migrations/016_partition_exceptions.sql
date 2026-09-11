-- Phase 20 (A12 #23) — partition exceptions (the care-inbox / alert queue) by
-- month, same reasoning and shape as 015_partition_access_log.sql.
--
-- notifications.exception_id's foreign key is dropped: Postgres requires a
-- foreign key INTO a partitioned table to reference a composite unique
-- constraint that includes the partition key, which would force
-- notifications to carry exceptions' created_at too just to satisfy the
-- constraint. Nothing in the app ever DELETEs from exceptions today (the ON
-- DELETE CASCADE has never fired), so this trades an unenforced reference
-- for the ability to partition — integrity between the two stays an
-- application-level concern, same as most FK-into-a-partitioned-table
-- tradeoffs. The column (and every existing value) is untouched.

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
    WHERE c.relname = 'exceptions'
  ) INTO already_partitioned;

  IF already_partitioned THEN
    RETURN;
  END IF;

  ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_exception_id_fkey;

  ALTER TABLE exceptions RENAME TO exceptions_pre_partition;

  CREATE TABLE exceptions (
    id                UUID NOT NULL DEFAULT gen_random_uuid(),
    kennel_id         VARCHAR(255) NOT NULL,
    kind              VARCHAR(64) NOT NULL,
    severity          VARCHAR(20) NOT NULL DEFAULT 'info',
    priority          INT NOT NULL DEFAULT 50,
    title             VARCHAR(255) NOT NULL,
    detail            TEXT,
    status            VARCHAR(20) NOT NULL DEFAULT 'open',
    device_id         VARCHAR(255),
    animal_id         UUID REFERENCES animals(id),
    pen_id            UUID REFERENCES pens(id),
    rule_id           UUID REFERENCES rules(id),
    suggested_action  TEXT,
    dedup_key         VARCHAR(255),
    assigned_to       UUID REFERENCES users(id),
    snoozed_until     TIMESTAMPTZ,
    escalation_step   INT DEFAULT 0,
    first_notified_at TIMESTAMPTZ,
    acknowledged_at   TIMESTAMPTZ,
    acknowledged_by   UUID REFERENCES users(id),
    resolved_at       TIMESTAMPTZ,
    resolved_by       UUID REFERENCES users(id),
    resolution_note   TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
  ) PARTITION BY RANGE (created_at);

  SELECT date_trunc('month', COALESCE(MIN(created_at), NOW()))::date,
         (date_trunc('month', NOW()) + INTERVAL '2 months')::date
    INTO first_month, last_month
    FROM exceptions_pre_partition;

  d := first_month;
  WHILE d <= last_month LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF exceptions FOR VALUES FROM (%L) TO (%L)',
      'exceptions_' || to_char(d, 'YYYY_MM'), d, d + INTERVAL '1 month'
    );
    d := d + INTERVAL '1 month';
  END LOOP;

  CREATE TABLE IF NOT EXISTS exceptions_default PARTITION OF exceptions DEFAULT;

  INSERT INTO exceptions
  SELECT id, kennel_id, kind, severity, priority, title, detail, status,
         device_id, animal_id, pen_id, rule_id, suggested_action, dedup_key,
         assigned_to, snoozed_until, escalation_step, first_notified_at,
         acknowledged_at, acknowledged_by, resolved_at, resolved_by,
         resolution_note, COALESCE(created_at, NOW()), updated_at
    FROM exceptions_pre_partition;

  DROP TABLE exceptions_pre_partition;
END $$;

CREATE INDEX IF NOT EXISTS idx_exceptions_open  ON exceptions (kennel_id, status, priority DESC);
CREATE INDEX IF NOT EXISTS idx_exceptions_dedup ON exceptions (kennel_id, dedup_key) WHERE status IN ('open', 'snoozed', 'escalated');
