-- Phase 21 (A11 — EMQX cluster depth / MQTT HA). The hardening plan's own
-- "broker down" degradation mode is: a device journals status updates locally
-- while disconnected and replays them on reconnect. `applyStatus()`
-- (src/services/feederMqtt.ts) applied whatever arrived last with no
-- ordering check, so a replayed (stale) status could overwrite a newer one
-- that had already landed via a different broker task or a since-received
-- live update. `last_status_ts` lets `applyStatus()` compare the device's own
-- reported `timestamp` (epoch ms, per `@jubasjl76-eng/mqtt-contract`) against
-- the last one actually applied, and drop anything not strictly newer.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_status_ts BIGINT;
