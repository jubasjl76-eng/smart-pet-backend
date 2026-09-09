-- Phase 9 slice 1 — firmware registry + staged-rollout controller. Idempotent.

-- One row per published build.
CREATE TABLE IF NOT EXISTS firmware (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_type  VARCHAR(20) NOT NULL,   -- feeder | water | door | gps | ...
  version      VARCHAR(32) NOT NULL,   -- semver, e.g. 1.4.2
  channel      VARCHAR(16) NOT NULL DEFAULT 'stable',  -- stable | beta
  url          TEXT NOT NULL,          -- where the .bin lives (S3 later, any URL now)
  sha256       VARCHAR(64) NOT NULL,
  signature    TEXT,                   -- detached signature, base64 (verified on-device)
  size_bytes   INT,
  min_version  VARCHAR(32),            -- refuse to OTA a device below this straight to here
  notes        TEXT,
  created_by   UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (device_type, version)
);

-- The rollout state machine. One live rollout per device_type; 'rolling' carries
-- the percent of the fleet (by a stable per-device hash bucket) that should move.
CREATE TABLE IF NOT EXISTS firmware_rollouts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firmware_id  UUID NOT NULL REFERENCES firmware(id) ON DELETE CASCADE,
  device_type  VARCHAR(20) NOT NULL,
  state        VARCHAR(16) NOT NULL DEFAULT 'rolling',  -- rolling | paused | done
  percent      INT NOT NULL DEFAULT 5,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by   UUID REFERENCES users(id)
);
-- At most one non-terminal rollout per device_type.
CREATE UNIQUE INDEX IF NOT EXISTS firmware_rollouts_live_idx
  ON firmware_rollouts (device_type) WHERE state <> 'done';

-- What each device last reported running.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS fw_version    VARCHAR(32);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS fw_updated_at TIMESTAMPTZ;
