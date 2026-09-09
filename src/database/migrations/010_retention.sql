-- Phase 8 slice 2 — retention windows. Idempotent.
--
-- One row per (kennel, data class) that the breeder has opted into. No row =
-- keep forever (the safe default). The engine's retentionSweep only touches a
-- class that has a row here with keep_days >= 1.
--
-- Classes: 'access_log' (purge access_log rows), 'document' (purge documents
-- rows + their stored files). Buyer / animal / litter erasure is the explicit
-- POST /privacy/delete path, never an automatic timer.

CREATE TABLE IF NOT EXISTS retention_settings (
  kennel_id  VARCHAR(255) NOT NULL,
  data_class VARCHAR(40) NOT NULL,
  keep_days  INT NOT NULL,
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (kennel_id, data_class)
);
