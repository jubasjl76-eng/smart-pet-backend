-- Phase 21 (A12 #20 — key-rotation drills). Revoking a firmware signing key
-- isn't a firmware-row property (one key signs many builds over time) — a
-- standalone table so revoking it blocks every build ever signed with it,
-- regardless of which rollout or manual push targets one.
CREATE TABLE IF NOT EXISTS revoked_signing_keys (
  signing_key_id VARCHAR(128) PRIMARY KEY,
  reason         TEXT,
  revoked_by     UUID REFERENCES users(id),
  revoked_at     TIMESTAMP NOT NULL DEFAULT NOW()
);
