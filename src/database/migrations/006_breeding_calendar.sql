-- Phase 6 — breeding calendar: heat cycles + mating detail on litters.
-- Idempotent.

CREATE TABLE IF NOT EXISTS heat_cycles (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kennel_id  VARCHAR(255) NOT NULL,
  animal_id  UUID NOT NULL REFERENCES animals(id) ON DELETE CASCADE,
  started_on DATE NOT NULL,
  ended_on   DATE,
  notes      TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS heat_cycles_animal_idx ON heat_cycles (animal_id, started_on DESC);

-- A "planned mating" is just a litter in status 'planned'; these columns hold
-- the mating detail once it happens.
ALTER TABLE litters
  ADD COLUMN IF NOT EXISTS mating_method VARCHAR(20),                 -- natural | ai | surgical-ai
  ADD COLUMN IF NOT EXISTS progesterone  JSONB NOT NULL DEFAULT '[]'::jsonb;  -- [{ on, ngml }]
