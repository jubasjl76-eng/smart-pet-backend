-- Phase 4 — real notification delivery: retry/backoff + provider receipts.
-- Idempotent.

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS max_attempts    INT NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS provider_ref    VARCHAR(255);

-- The drain worker polls queued rows whose retry time has come.
CREATE INDEX IF NOT EXISTS notifications_due_idx
  ON notifications (next_attempt_at)
  WHERE status = 'queued';
