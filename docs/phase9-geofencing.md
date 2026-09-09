# GPS geofencing (Phase 9, slice 2)

Safe-zone CRUD, position ingest with enter/exit detection, and an escape alert
into the care inbox.

## Schema (`012_geofencing.sql`)

- **`safe_zones`** — a circular zone. `kind` is `boundary` (the dog should stay
  inside; an exit is an escape) or `exclusion` (should stay out; an entry is an
  alert). `center_lat` / `center_lng` / `radius_m` (min 10). `animal_id` NULL =
  applies to every collared animal in the kennel.
  ponytail: circles only. A polygon fit is a later refinement.
- **`geofence_state`** — `(animal_id, zone_id)` → `inside` bool + `since`. Lets
  ingest alert on a *crossing*, not on every fix while outside.
- **`animals.last_lat` / `last_lng` / `last_fix_at`** — the latest fix.

## Detection maths (`src/breeder/logic/geofence.ts`, pure)

- `haversineMeters(a, b)`, `insideZone(point, zone)`
- `isEscape(zone, 'enter'|'exit')` → boundary-exit or exclusion-enter
- `evaluate(point, zones, prevInsideIds)` → `{ insideIds, entered[], exited[] }`

## Routes — `/api/breeder/geo` (behind the breeder guard)

| method + path | does |
|---|---|
| `GET /zones` | list, with `animal_name` |
| `POST /zones` | `{ name, centerLat, centerLng, radiusM?, kind?, animalId? }` |
| `PATCH /zones/:id` | any of name / kind / radiusM / centerLat / centerLng / active |
| `DELETE /zones/:id` | remove (cascades `geofence_state`) |
| `POST /positions` | `{ animalId? | deviceId?, lat, lng, at? }` — ingest one fix |
| `GET /positions/latest` | every collared animal's last fix + the zones it's currently inside (console map) |

### `POST /positions`

Resolves the animal by `animalId` or by `animals.collar_device_id = deviceId`
(404 if neither matches). Updates `animals.last_*`, evaluates every active zone,
writes the crossings to `geofence_state`, and for each escaping crossing raises a
`geofence-escape` exception (`severity: critical`, `notifyAudience: on-call`,
`dedupKey: geofence-escape:<animalId>` so repeats bump one alert). Coming back
inside any `boundary` zone auto-resolves that standing alert.

Returns `{ animalId, insideZoneIds, entered, exited, alerts }`.

`ingestPosition(kennelId, fix)` is exported so an MQTT subscriber on
`kennel/+/gps/+/status` can call the same path once the collar firmware lands
(Phase 9.4). No engine sweep: detection is synchronous on ingest so an escape
alerts immediately.

## Console (Cursor's Phase 9 geofencing task)

On the Fleet / map screen:

- draw + edit circular zones on a map (`POST` / `PATCH` / `DELETE /geo/zones`),
  toggle `active`, pick `boundary` vs `exclusion`.
- plot each collared dog from `GET /geo/positions/latest`; highlight any dog
  whose `inside_zone_ids` is empty for a boundary-only kennel.
- the escape itself shows up in the existing care inbox as a `geofence-escape`
  exception; no new alert UI needed.
