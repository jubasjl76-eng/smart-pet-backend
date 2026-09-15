-- Phase 12: feature flags. A tiny key -> bool table read by GET /api/config so
-- the dashboard / app can gate UI without a redeploy. Idempotent.

CREATE TABLE IF NOT EXISTS feature_flags (
  key         TEXT PRIMARY KEY,
  enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  description TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
