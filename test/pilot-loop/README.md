# Pilot loop tests (24 Sep)

Fail-closed gates for the feeder pilot. GPS/cameras/sensors/water are out of scope.

Branch from `development`. PR into `development`. Never cut `main`.

Required env (missing = fail, not skip):
- `PILOT_BACKEND_URL` (must not be :3002)
- `DATABASE_URL`
- `MQTT_URL`
- `PILOT_JWT` (do not commit tokens; do not use TESTING.md)
