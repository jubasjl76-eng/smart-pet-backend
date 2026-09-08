-- Phase 1 — auth, kennel setup, device pairing.
-- Idempotent: safe to re-run and safe alongside the legacy boot DDL.

-- ── users: active flag for deactivation ──────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS kennel_id VARCHAR(255);

-- ── kennels: setup wizard state ─────────────────────────────────────────────
ALTER TABLE kennels ADD COLUMN IF NOT EXISTS setup_complete BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE kennels ADD COLUMN IF NOT EXISTS setup_completed_at TIMESTAMPTZ;

-- ── refresh tokens (rotating) ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(255) NOT NULL,          -- sha-256 of the opaque token
  family UUID NOT NULL DEFAULT gen_random_uuid(),  -- reuse-detection lineage
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  replaced_by UUID,
  user_agent VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_refresh_hash ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id) WHERE revoked_at IS NULL;

-- ── staff / owner invites ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_invites (
  token VARCHAR(64) PRIMARY KEY,             -- opaque, emailed to the invitee
  email VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'staff', -- owner | staff
  kennel_id VARCHAR(255) NOT NULL,
  invited_by UUID REFERENCES users(id),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  accepted_user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_invite_email ON user_invites(lower(email)) WHERE accepted_at IS NULL;

-- ── device pairing codes ───────────────────────────────────────────────────
-- A staff member generates a short code, types it into the device's setup
-- portal (or the claim screen); the device then claims itself against it.
CREATE TABLE IF NOT EXISTS device_pairings (
  code VARCHAR(16) PRIMARY KEY,              -- e.g. FEED-7K2Q
  kennel_id VARCHAR(255) NOT NULL,
  device_type VARCHAR(20) NOT NULL,          -- feeder | water | door | sensor | gps | scale | hub
  suggested_name VARCHAR(255),
  pen_id UUID,                               -- optional: bind to a pen on claim
  created_by UUID REFERENCES users(id),
  claimed_device_id VARCHAR(255),
  claimed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pairing_open ON device_pairings(kennel_id) WHERE claimed_at IS NULL;

-- ── devices: link to a pen + track who/what claimed it ──────────────────────
ALTER TABLE devices ADD COLUMN IF NOT EXISTS pen_id UUID;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS claimed_by UUID;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
