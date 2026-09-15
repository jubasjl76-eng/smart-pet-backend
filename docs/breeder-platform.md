# Breeder platform (`/api/breeder/*`)

Slice 1 of the Smart Pet build. Adds a breeder-focused domain layer on top of the
existing Postgres + JWT + MQTT feeder loop.

- **Code:** `src/breeder/`
- **Schema:** `src/breeder/schema.ts` → `BREEDER_DDL`, applied by `initBreederSchema()` on boot
- **Mount:** `mountBreeder(app)` in `src/index.ts` (all routes behind `auth` + `withKennel`)
- **Engine:** `startBreederEngine()` — MQTT subscriber (`kennel/+/+/+/+`) + a periodic tick
- **Tests:** `src/__tests__/breeder-*.test.ts` (pure logic + pglite schema + pglite exceptions)

There is **one kennel per deployment** (`BREEDER_KENNEL_SLUG`, default `home`) — the
same string used as the MQTT `kennelId`. Every user is attached to it; `withKennel`
resolves `req.kennelId` per request.

---

## What each approved idea maps to

| Idea                                             | Where                                                                                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-dog **Care Plan**                            | `animals` + `care_plans`; `PUT /animals/:id/care-plan`                                                                                                                          |
| **Care inbox / exception queue**                 | `exceptions` + `src/breeder/exceptions.ts`; `/inbox/*` (ack/snooze/resolve/escalate/assign/reopen), live priority re-rank                                                       |
| **Rules / automation engine**                    | `rules` + `logic/rules.ts` + `engine/rulesEngine.ts`; `/rules/*`, `POST /rules/install-presets`, `POST /rules/:id/test`                                                         |
| **Notification service**                         | `notifications` + `notification_prefs` + `engine/notifier.ts`; channels: `log`, `webhook` (real), `sms`/`email`/`push`/`siren` (adapter stubs); quiet hours + escalation chains |
| **Predictive maintenance**                       | `device_health_counters` + `logic/maintenance.ts`; counters bumped in `rulesEngine`; `/ops/maintenance*`                                                                        |
| **Emergency mode**                               | `emergency_events` + `kennels.emergency_*`; `/ops/emergency/{trigger,end,status,manifest}` — unlocks pen doors over MQTT, builds an evac manifest                               |
| **Weight & growth curves**                       | `weight_readings` + `logic/growth.ts` (Gompertz expected curve, deviation flags); `/animals/:id/weights`, `/animals/:id/growth`, puppy variants under `/litters`                |
| **Multi-dog identification**                     | `intake_events.identified_by` + `expected_animal_id` + `mismatch`; `POST /animals/intake` raises a `wrong-pen` exception on mismatch (B2B and B2C)                              |
| **Smart scale bowl**                             | `weight_readings.source='scale'` + `intake_events.grams_consumed`; same endpoints, `deviceId` set                                                                               |
| **Consumables warning**                          | `consumables` + `logic/consumables.ts` (run-out projection); `/ops/consumables*`, engine sweep raises `consumable-low` (no auto-order)                                          |
| **Offline / power-cut behaviour**                | `offline_journal`; `POST /ops/offline-journal` (device reports its dark window on reconnect); engine `detectOffline()` flags stale devices                                      |
| **Activity & wellness insights**                 | `logic/wellness.ts`; `GET /animals/:id/wellness` (intake / water / activity / weight trends → plain-language, non-diagnostic)                                                   |
| **Medication log** (staff-administered)          | `medications` + `medication_logs` + `logic/medications.ts`; `/medications/*`, `POST /medications/:id/log`, `/:id/compliance`, `sweep-missed`                                    |
| **Automated play / enrichment**                  | `enrichment_sessions` + `logic/enrichment.ts`; `POST /ops/enrichment/generate` (round-robin rotation), `/complete` records activity minutes                                     |
| Litters / whelping (replaces check-in)           | `litters` + `puppies`; `/litters/*`, `POST /litters/:id/whelp`                                                                                                                  |
| Buyer waitlist (replaces booking)                | `buyers`; `/litters/buyers*`                                                                                                                                                    |
| Puppy buyer "update pack" (replaces stay report) | `GET /litters/puppies/:pupId/update-pack` (weight series + gain + health log)                                                                                                   |

---

## Route index

All routes require `Authorization: Bearer <jwt>`.

### Animals & care — `/api/breeder/animals`

```
GET    /pens                       list pens + occupancy
POST   /pens
GET    /                           list animals
POST   /                           create animal (sire/dam, collar, ble_tag, pen, adult_weight_kg)
GET    /:id                        animal + care plan
PATCH  /:id
POST   /:id/move                   { penId }
PUT    /:id/care-plan              upsert diet / meds summary / vet / contacts
POST   /:id/weights                { grams, source?, deviceId? } → assessment + auto-exceptions
GET    /:id/growth                 weight series vs expected Gompertz curve
POST   /intake                     { deviceId, kind:'food'|'water', animalId?, gramsDispensed?, gramsConsumed?, identifiedBy? }
GET    /:id/wellness               insight list
```

### Litters, puppies, buyers — `/api/breeder/litters`

```
GET    /                           litters + counts
POST   /                           plan a litter
POST   /:id/whelp                  { whelpedAt?, countBorn, countAlive }
GET    /:id/puppies                puppies + per-pup growth assessment
POST   /:id/puppies                add a puppy (birth weight seeds a reading)
POST   /puppies/:pupId/weights
PATCH  /puppies/:pupId             status / buyer / go_home_on
GET    /buyers/list
POST   /buyers                     auto-assigns waitlist rank
PATCH  /buyers/:buyerId            assign to a puppy → puppy goes 'reserved'
GET    /puppies/:pupId/update-pack data half of the weekly buyer pack
```

### Medications — `/api/breeder/medications`

```
GET    /                           all meds (+ animal name)
POST   /                           { animalId, name, dose, route, timesOfDay[], daysOfWeek[] }
PATCH  /:id
GET    /due?hours=24               staff worklist of upcoming doses
POST   /:id/log                    { outcome:'given'|'skipped'|'refused'|'vomited', note?, photoUrl? }
GET    /:id/compliance             30-day rate + recent missed
POST   /sweep-missed               raise med-missed exceptions now
```

### Care inbox — `/api/breeder/inbox`

```
GET    /?status=active|all|<status>   ranked by live priority; returns counts
GET    /:id                           exception + its notifications
POST   /                              manually raise one
POST   /:id/acknowledge | /snooze { minutes } | /resolve { note } | /escalate | /assign { userId } | /reopen
```

### Rules — `/api/breeder/rules`

```
GET    /
POST   /                           { name, trigger, conditions?, actions, cooldownSeconds? }
PATCH  /:id      DELETE /:id
POST   /install-presets            7 parameterised starter rules
POST   /:id/test                   dry-run against a sample event
GET    /:id/firings
```

### Ops — `/api/breeder/ops`

```
GET/POST/PATCH  /consumables[...]          + POST /consumables/sweep
GET            /maintenance                per-device counters + predictions
PUT            /maintenance/:deviceId/:metric/limit     { serviceLimit }
POST           /maintenance/:deviceId/:metric/serviced
GET            /emergency/status | /emergency/manifest
POST           /emergency/trigger { mode:'fire'|'flood'|'evac'|'drill' } | /emergency/end
GET/POST       /enrichment | /enrichment/generate { stations[], animalIds?, date?, dayStart?, dayEnd?, slotMinutes? }
POST           /enrichment/:id/complete    { activityMinutes }
GET/POST       /offline-journal
GET/PUT        /notification-prefs         { channels[], quietHours{start,end,overrideSeverity}, escalation[], webhookUrl, smsNumber, email }
```

---

## Engine

`startBreederEngine()`:

1. **MQTT** — subscribes `kennel/+/+/+/+`, `normaliseMessage()` turns each into `RuleEvent`s
   (`device_status`, `telemetry`, `low_battery`, `feed_acked`, `door_opened`, `jam`),
   `ingestEvent()` updates maintenance counters then evaluates enabled rules and runs actions.
2. **Tick** (`BREEDER_TICK_MS`, default 60 s): `notifierTick()` (escalations + queue drain),
   consumable sweep, missed-medication sweep, offline detection, plus the
   vaccination/update-pack/breeding/retention/fleet sweeps.

Every instance's timer fires the tick locally, but `withLeaderLock()`
(`src/leaderLock.ts`, Phase 20) gates the actual work behind a Redis
`SET NX PX` so only one instance runs it per window at prod's ×2+ scale — a
no-op single-instance lock (always acquires) when `REDIS_URL` is unset.

Runs fine with no broker (mqtt.js retries; the tick is broker-independent).

---

## Rule shape

```jsonc
{
  "name": "Whelping-room temperature high",
  "trigger": { "type": "telemetry", "metric": "temperature" },
  "conditions": [{ "field": "value", "op": "gt", "value": 28 }],
  "actions": [
    {
      "type": "raise_exception",
      "kind": "temp-high",
      "severity": "critical",
      "title": "…",
      "suggestedAction": "…",
    },
    { "type": "set_pen_relay", "relay": "fan", "state": "on" },
    { "type": "notify", "audience": "on-call" },
  ],
  "cooldownSeconds": 600,
}
```

Trigger types: `device_status`, `telemetry`, `missed_meal`, `low_battery`, `wrong_pen`,
`device_offline`, `maintenance_due`. Condition ops: `eq ne gt gte lt lte in between`.
Action types: `raise_exception`, `notify`, `device_command`, `set_pen_relay`.

---

## Baseline repairs made to land this slice

`origin/development` did not compile. Fixed as prerequisites (unrelated to breeder features):

- `mqtt/contract.ts` — added the missing `parseStatusPayload`, `isDeviceOnline`,
  `deriveIsFoodLow`, `lastFeedToMs`, `isForbiddenTopic`, `buildLwtPayload`, `buildScheduleSet`
  that `statusIngest.ts` / `feedNow.ts` / their tests already import.
- `services/feederMqtt.ts` — added the `FeederBus` seam (`createMemoryBus`, `notifyStatus`,
  `setFeederBus`) the command-path tests use; kept the live path.
- `middleware/deviceAuth.ts` — `parseDeviceBasic` now splits on the **last** colon
  (device usernames are `device:<id>`, which contains a colon).
- `controllers/authController.ts` — `register` inserts via `execute` then reads back,
  and never mints `staff`.
- `package.json` — dropped the stale `@types/express-validator@2` shadowing express-validator v7's own types.
- `tsconfig.json` — excludes the dead Mongoose `src/models/**`, `collarController.ts`,
  `routes/collar.ts`, and the unused `src/app.ts` (referenced a non-existent `getStats`).

Result: `npx tsc --noEmit` clean, `npx vitest run` = 83 passing (32 pre-existing + 51 new).

---

## Not in this slice (later)

Firmware (`smart-pet-device-sdk`, pen-door / scale / BLE-tag / two-way-audio / RTC-offline),
the "Pet Hub", the MQTT contract additions for the new device types, the simulation/QA
harness, the dashboards/app wiring, and the privacy & data-governance model.
