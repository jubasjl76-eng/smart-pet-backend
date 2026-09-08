-- Phase 3 — public marketing site.
-- Adds a per-row publish gate + public-facing fields consumed by
-- smart-pet-website's /api/public/* routes. Idempotent.

ALTER TABLE animals
  ADD COLUMN IF NOT EXISTS published    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS photos       JSONB   NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS titles       TEXT,
  ADD COLUMN IF NOT EXISTS bio          TEXT,
  ADD COLUMN IF NOT EXISTS health_tests JSONB   NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE litters
  ADD COLUMN IF NOT EXISTS published          BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS photos             JSONB   NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS public_description TEXT;

ALTER TABLE puppies
  ADD COLUMN IF NOT EXISTS published BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS photos    JSONB   NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS color     VARCHAR(64);

ALTER TABLE kennels
  ADD COLUMN IF NOT EXISTS public_tagline  TEXT,
  ADD COLUMN IF NOT EXISTS public_about    TEXT,
  ADD COLUMN IF NOT EXISTS public_email    VARCHAR(255),
  ADD COLUMN IF NOT EXISTS public_phone    VARCHAR(64),
  ADD COLUMN IF NOT EXISTS public_location VARCHAR(255),
  ADD COLUMN IF NOT EXISTS public_socials  JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Where website inquiries land: a normal waitlist buyer, tagged by origin.
ALTER TABLE buyers
  ADD COLUMN IF NOT EXISTS source VARCHAR(32);

-- The public queries only ever ask for published rows.
CREATE INDEX IF NOT EXISTS animals_published_idx ON animals (kennel_id) WHERE published;
CREATE INDEX IF NOT EXISTS litters_published_idx ON litters (kennel_id) WHERE published;
CREATE INDEX IF NOT EXISTS puppies_published_idx ON puppies (litter_id) WHERE published;
