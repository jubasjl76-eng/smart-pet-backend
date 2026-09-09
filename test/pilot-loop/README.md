# Pilot loop tests (24 Sep)

Fail-closed **manual** integration gates for the feeder pilot: real HTTP + MQTT
round-trips against a running stack. GPS/cameras/sensors/water are out of scope.

Not run in CI. The `.github/workflows/feeder-loop.yml` job was removed: it never
passed (wrong `vitest` invocation, and it needs a `PILOT_JWT` secret + a live
`docker compose` stack). Unit/integration coverage now runs via
`.github/workflows/ci.yml` (`vitest run`, pglite, no external services).

## Run locally

```bash
docker compose up -d --build
PILOT_BACKEND_URL=http://localhost:3000 \
DATABASE_URL=postgres://postgres:postgres@localhost:5432/smartpet \
MQTT_URL=mqtt://localhost:1883 \
PILOT_JWT=<owner or staff JWT> \
npx vitest run --dir test/pilot-loop
```

Required env (missing = fail, not skip):
- `PILOT_BACKEND_URL` (must not be :3002)
- `DATABASE_URL`
- `MQTT_URL`
- `PILOT_JWT` (do not commit tokens; do not use TESTING.md)
