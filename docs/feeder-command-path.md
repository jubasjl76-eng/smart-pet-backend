# Feeder command path

Run `npm test` then `npm run dev` on port 3000.

- Register is localhost only and always creates role owner.
- Collar routes are not mounted (mongoose leftover, out of scope).
- src/services/mqttConsumer.ts is quarantined.
- Owner Bearer on devices, schedules, feed, levels, stats.
- Device HTTP ingress uses HTTP Basic username device:<deviceId>.
- MQTT command QoS 2: kennel/{kennelId}/feeder/{deviceId}/command
- MQTT status retained QoS 1: kennel/{kennelId}/feeder/{deviceId}/status
- Feed Now succeeds on device ack plus status, not device_events insert.
