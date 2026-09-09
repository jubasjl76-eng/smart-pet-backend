-- Phase 5 — vaccination & worming records the go-home pack depends on.
-- Idempotent.

CREATE TABLE IF NOT EXISTS vaccination_protocols (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kennel_id  VARCHAR(255) NOT NULL,
  name       VARCHAR(255) NOT NULL,
  species    VARCHAR(32) DEFAULT 'dog',
  doses      JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{ name, atAgeDays, kind }]
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vaccination_records (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kennel_id       VARCHAR(255) NOT NULL,
  animal_id       UUID REFERENCES animals(id) ON DELETE CASCADE,
  puppy_id        UUID REFERENCES puppies(id) ON DELETE CASCADE,
  protocol_id     UUID REFERENCES vaccination_protocols(id) ON DELETE SET NULL,
  name            VARCHAR(255) NOT NULL,
  kind            VARCHAR(20) NOT NULL DEFAULT 'vaccine',   -- vaccine | worming
  due_on          DATE,
  given_on        DATE,
  batch_no        VARCHAR(128),
  vet_name        VARCHAR(255),
  certificate_url TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT vacc_subject_ck CHECK (animal_id IS NOT NULL OR puppy_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS vacc_due_idx ON vaccination_records (due_on) WHERE given_on IS NULL;
CREATE INDEX IF NOT EXISTS vacc_animal_idx ON vaccination_records (animal_id);
CREATE INDEX IF NOT EXISTS vacc_puppy_idx ON vaccination_records (puppy_id);
