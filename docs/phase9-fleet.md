# Fleet & firmware (Phase 9, slice 1)

Firmware registry + staged-rollout controller + a reported-vs-target fleet view.
Slices 9.2 (GPS geofencing), 9.3 (SDK PlatformIO CI) and 9.4 (device ports,
two-way audio) are separate.

## Schema (`011_fleet_firmware.sql`)

- **`firmware`** — one row per published build. `device_type`, `version`
  (semver), `channel` (`stable` | `beta`), `url` (the `.bin`; any URL now, S3
  in Phase 10), `sha256`, `signature` (detached, base64, verified on-device),
  `size_bytes`, `min_version`, `notes`. `UNIQUE (device_type, version)`.
- **`firmware_rollouts`** — the state machine. `state` is `rolling` | `paused` |
  `done`; `percent` (1..100) is the share of the fleet, by a stable per-device
  hash bucket, that should move. Partial unique index keeps at most one
  non-`done` rollout per `device_type`.
- **`devices.fw_version` / `fw_updated_at`** — what the device last reported.
  Populated from the MQTT status payload (`fw` or `fwVersion` field); null until
  a device firmware reports it (Phase 9.4 widens status ingest beyond feeders).

## Rollout maths (`src/breeder/logic/rollout.ts`, pure)

- `deviceBucket(deviceId)` → 0..99, `sha1(deviceId)` based, stable.
- `deviceTarget(rollout, version, deviceId)` → the version this device should
  run, or `null`. Non-`rolling` rollouts and out-of-bucket devices get `null`.
- `deviceFwStatus(reported, target)` → `unknown` | `up-to-date` | `pending`.

`percent` only ever increases (`PATCH` rejects a decrease), so a device that
entered the wave never drops out of it.

## Routes — `/api/breeder/fleet` (behind the breeder guard)

The plan names this `POST /api/fleet/firmware`; it sits under `/api/breeder`
with every other tenant route so it shares the auth + kennel guard.

| method + path | body / query | does |
|---|---|---|
| `POST /firmware` | `{ deviceType, version, url, sha256, channel?, signature?, sizeBytes?, minVersion?, notes? }` | register a build. `409` on a duplicate `(deviceType, version)` |
| `GET /firmware` | `?deviceType=` | list builds, newest first |
| `POST /rollouts` | `{ firmwareId, percent? }` | start a rollout (default canary 5%). Closes any live rollout for that device type first |
| `PATCH /rollouts/:id` | `{ state?, percent? }` | advance (`percent` up only), `paused`, or `done` (forces 100) |
| `GET /rollouts` | | live + recent (50) |
| `GET /devices` | | every device with `fwVersion` (reported), `target`, `fwStatus`, `isOnline`, `lastSeen` |
| `POST /devices/:deviceId/ota` | `{ firmwareId? }` | push the OTA offer to one device now (canary / manual retry). `firmwareId` optional, else the live rollout's build. `502` if the broker rejects |
| `POST /sweep` | | run `fleetSweep()` now |

Rollout start / update / manual OTA are written to the access log
(`fleet.rollout.start`, `fleet.rollout.update`, `fleet.ota.push`).

## Engine sweep — `fleetSweep()`

On every engine tick. For each live `rolling` rollout: take that device type's
**online** devices, and for each one that is in-bucket and not already on the
target version, publish an `ota` command
(`{ command: 'ota', params: { url, version, sha256, signature } }`) on
`kennel/<k>/<deviceType>/<deviceId>/command`. Capped at 10 pushes per tick
(`OTA_PER_TICK`); the next tick continues. A broker or device error is
swallowed and retried next tick. Pausing the rollout stops all of it.

The OTA command is an **offer** — the device verifies `sha256` + `signature`
and decides when to apply it (A/B partitions, not mid-action). That side is
Phase 9.4.

## Not in this slice

- Signature *generation* (a build/CI concern) — the backend stores and forwards
  whatever signature string it's given.
- Widening MQTT status ingest to water / collar / door so they report `fw`
  (Phase 9.4).
- Rollback to an earlier version (roll forward to a new build instead).

## Console (Cursor's Phase 9 task)

A **Fleet** screen:

- device list from `GET /fleet/devices` — type, name, online, reported version,
  target, a `fwStatus` chip (`up-to-date` / `pending` / `unknown`).
- firmware list + an "upload build" form (`POST /fleet/firmware`).
- rollout controls: start (`POST /fleet/rollouts`), a percent slider that only
  moves up, pause / resume / finish (`PATCH`), and per-device "send now"
  (`POST /fleet/devices/:id/ota`).
