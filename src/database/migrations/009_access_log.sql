-- Phase 8 slice 1 — access log. Append-only record of who read sensitive data
-- (document downloads now; camera/door reads when those endpoints land in
-- Phase 9/10). Idempotent.

CREATE TABLE IF NOT EXISTS access_log (
  id           BIGSERIAL PRIMARY KEY,
  kennel_id    VARCHAR(255) NOT NULL,
  user_id      UUID,
  action       VARCHAR(40) NOT NULL,   -- document.download | camera.view | door.open | privacy.export ...
  subject_type VARCHAR(20),            -- document | buyer | puppy | animal | litter | device
  subject_id   VARCHAR(255),           -- not always a UUID (device ids)
  ip           VARCHAR(64),
  detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
  at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS access_log_kennel_idx  ON access_log (kennel_id, at DESC);
CREATE INDEX IF NOT EXISTS access_log_subject_idx ON access_log (subject_type, subject_id);
