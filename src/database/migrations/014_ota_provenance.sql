-- Phase 19 — OTA provenance. Record which key signed a build and any build
-- provenance (SLSA attestation ref) alongside the artifact hash. Idempotent.

ALTER TABLE firmware ADD COLUMN IF NOT EXISTS signing_key_id VARCHAR(128);
ALTER TABLE firmware ADD COLUMN IF NOT EXISTS provenance     JSONB;
