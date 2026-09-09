-- Phase 7 — documents & paperwork. Idempotent.

CREATE TABLE IF NOT EXISTS documents (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kennel_id    VARCHAR(255) NOT NULL,
  kind         VARCHAR(32) NOT NULL DEFAULT 'other',
  -- registration | contract | receipt | guarantee | certificate | handoff | photo | other
  subject_type VARCHAR(20),   -- animal | puppy | buyer | litter
  subject_id   UUID,
  title        VARCHAR(255),
  filename     VARCHAR(255),
  content_type VARCHAR(128),
  size_bytes   INT,
  storage_key  TEXT,          -- null for a generated text-only document
  body         TEXT,          -- generated docs (contract / receipt / guarantee)
  meta         JSONB NOT NULL DEFAULT '{}'::jsonb,
  uploaded_by  UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS documents_subject_idx ON documents (subject_type, subject_id);
CREATE INDEX IF NOT EXISTS documents_kennel_idx  ON documents (kennel_id, created_at DESC);
