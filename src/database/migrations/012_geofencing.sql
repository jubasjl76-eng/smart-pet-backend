-- Phase 9 slice 2 — GPS geofencing. Idempotent.

-- A circular zone. 'boundary' = the dog should stay inside (an exit is an
-- escape). 'exclusion' = the dog should stay out (an entry is an alert).
-- animal_id NULL = applies to every collared animal in the kennel.
CREATE TABLE IF NOT EXISTS safe_zones (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kennel_id   VARCHAR(255) NOT NULL,
  animal_id   UUID REFERENCES animals(id) ON DELETE CASCADE,
  name        VARCHAR(255) NOT NULL,
  kind        VARCHAR(16) NOT NULL DEFAULT 'boundary',  -- boundary | exclusion
  center_lat  DOUBLE PRECISION NOT NULL,
  center_lng  DOUBLE PRECISION NOT NULL,
  radius_m    INT NOT NULL DEFAULT 100,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS safe_zones_kennel_idx ON safe_zones (kennel_id) WHERE active;

-- Which zones each animal is currently inside, so we only alert on a crossing.
CREATE TABLE IF NOT EXISTS geofence_state (
  animal_id  UUID NOT NULL REFERENCES animals(id) ON DELETE CASCADE,
  zone_id    UUID NOT NULL REFERENCES safe_zones(id) ON DELETE CASCADE,
  inside     BOOLEAN NOT NULL,
  since      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (animal_id, zone_id)
);

ALTER TABLE animals ADD COLUMN IF NOT EXISTS last_lat    DOUBLE PRECISION;
ALTER TABLE animals ADD COLUMN IF NOT EXISTS last_lng    DOUBLE PRECISION;
ALTER TABLE animals ADD COLUMN IF NOT EXISTS last_fix_at TIMESTAMPTZ;
