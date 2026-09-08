# Phase 1 — Auth, kennel setup & device pairing

The "way in" to the breeder platform. Everything runs locally on `docker compose`.

## Run the stack

```bash
cd smart-pet-backend
JWT_SECRET=dev-secret docker compose up --build
#   postgres  :5432   ·  mosquitto :1883   ·   backend :3000
#   dashboard :5173   opt-in:  docker compose --profile dashboard up
```

The **backend** applies the schema on boot in order: base DDL → breeder DDL →
`src/database/migrations/*.sql` (some migrations `ALTER` tables the breeder
schema owns, so they must run last). Same on `npm run dev`.

Standalone (self-sufficient — ensures the full schema first, then migrates):

```bash
npm run migrate            # apply pending
npm run migrate -- --status
```

Drive devices with the simulator:

```bash
cd ../smart-pet-simulator
npm run sim -- --scenario feeder-jam --broker mqtt://localhost:1883
```

## Auth

Access tokens are short-lived (`ACCESS_TTL`, default 12h); a **rotating** refresh
token (`REFRESH_TTL_DAYS`, default 30) is issued alongside and swapped at
`/api/auth/refresh`. Reusing a spent refresh token revokes its whole family.
Every response still includes `token` (= `accessToken`) for older callers.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/register` | localhost-only; always `owner`; returns `{user, accessToken, refreshToken}` |
| POST | `/api/auth/login` | `{email, password}` → `{user, accessToken, refreshToken}`; 403 if deactivated |
| POST | `/api/auth/refresh` | `{refreshToken}` → new pair |
| POST | `/api/auth/logout` | `{refreshToken}` revokes one; bare (with Bearer) revokes all for the user |
| POST | `/api/auth/accept-invite` | `{token, name, password}` → creates the account, returns a session |
| GET | `/api/auth/me` | current user |

Deactivated users (`active = false`) are rejected by the `auth` middleware and at login; their refresh tokens are revoked.

## Kennel setup wizard

Single breeding operation. `GET /api/setup/status` drives the wizard.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/setup/status` | `{setupComplete, canAdminister, kennel, steps:{kennel,pens,animals,rules,devices}, counts}` |
| POST | `/api/setup/kennel` | `{name, breedFocus?, timezone?}` — creates the kennel (first owner becomes `owner_user_id`), binds all users to it |
| POST | `/api/setup/complete` | marks setup finished |
| POST | `/api/setup/seed-demo` | one-shot: 4 pens + a dam + a sire + the 7 preset rules |

Pens, animals and rules are created through the existing `/api/breeder/*` endpoints; the wizard just calls them.

## Users & invites  (`/api/users`, owner-only)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/users` | users in the kennel |
| POST | `/api/users/invite` | `{email, role: owner\|staff}` → `{token, acceptUrl}` (email delivery is Phase 3) |
| GET | `/api/users/invites` | open + recent |
| DELETE | `/api/users/invites/:token` | revoke |
| PATCH | `/api/users/:id` | `{role?, active?}` — can't remove the last active owner or deactivate yourself |

## Device pairing & claiming  (`/api/breeder/ops/devices`, owner or staff)

A staff member mints a short code (`FEED-7K2Q`), enters it into the device's
setup portal (or the claim screen), and the device claims itself against it —
which binds it to the kennel + pen, mints its MQTT credentials **once**, and
refreshes the broker ACL.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/breeder/ops/devices` | every device in the kennel + provisioning state |
| POST | `/api/breeder/ops/devices/pairing` | `{deviceType, name?, penId?}` → `{code, expiresAt}` (TTL `PAIRING_TTL_MIN`) |
| GET | `/api/breeder/ops/devices/pairing` | open codes |
| DELETE | `/api/breeder/ops/devices/pairing/:code` | cancel |
| POST | `/api/breeder/ops/devices/claim` | `{code, deviceId, name?}` → `{device, mqtt:{username, password (once), host, topics}}` |

`deviceType` ∈ `feeder water door sensor gps scale hub`. A `hub` device gets the
whole `kennel/<slug>/#` ACL prefix; others are scoped to their own topic.

## MQTT ACL

Local Mosquitto stays anonymous (`allow_anonymous true`) — a laptop, one kennel.
The **ACL model is real** (`src/mqtt/acl.ts`): set `MOSQUITTO_ACL_PATH` and the
file is regenerated from the `devices` table on every claim. At Phase 9 the same
rules drive EMQX.

Rules per device (`device:<id>`): may **subscribe** only `…/<id>/command`, may
**publish** only `…/<id>/{status,event,ack,telemetry,location,presence,<metric>}`.

## Migrations

`src/database/migrations/NNN_name.sql`, applied in order, tracked in `_migrations`,
each in a transaction. Files are idempotent so they coexist with the legacy boot
DDL. `runMigrations(pool)` is called from `initializeDatabase()`; the CLI
(`npm run migrate`) is what a deploy pipeline runs as a one-off task.

## Tests

`npm test` — Phase 1 adds `phase1-logic.test.ts` (sha256, pairing codes, ACL
generation) and `phase1-flows.test.ts` (refresh rotation + reuse detection,
invite lifecycle, pairing + claim) against pglite. **100 passing.**
