-- Phase 5 (slice 2) — buyer messaging + weekly update-pack scheduling.
-- Idempotent.

CREATE TABLE IF NOT EXISTS buyer_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kennel_id       VARCHAR(255) NOT NULL,
  buyer_id        UUID REFERENCES buyers(id) ON DELETE CASCADE,
  litter_id       UUID REFERENCES litters(id) ON DELETE SET NULL,
  puppy_id        UUID REFERENCES puppies(id) ON DELETE SET NULL,
  kind            VARCHAR(20) NOT NULL DEFAULT 'direct',   -- direct | broadcast | update-pack
  subject         VARCHAR(255),
  body            TEXT,
  notification_id UUID REFERENCES notifications(id) ON DELETE SET NULL,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS buyer_messages_buyer_idx ON buyer_messages (buyer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS update_pack_subscriptions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kennel_id    VARCHAR(255) NOT NULL,
  buyer_id     UUID NOT NULL REFERENCES buyers(id) ON DELETE CASCADE,
  puppy_id     UUID NOT NULL REFERENCES puppies(id) ON DELETE CASCADE,
  cadence      VARCHAR(16) NOT NULL DEFAULT 'weekly',
  next_run_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_sent_at TIMESTAMPTZ,
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (buyer_id, puppy_id)
);
CREATE INDEX IF NOT EXISTS update_pack_due_idx ON update_pack_subscriptions (next_run_at) WHERE active;
