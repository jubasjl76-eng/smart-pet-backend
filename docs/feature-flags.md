# Feature flags (Phase 12 seed, fleshed out Phase 20)

A `feature_flags` table (`013_feature_flags.sql`) — `key → enabled` (+ an
optional `description`) — lets an operator gate a rollout without a
redeploy. No row for a key = off; there's no default-on.

## Reading a flag

- **Client-side** (dashboard / app): `GET /api/config` already includes
  `flags: { key: enabled, ... }` (`src/services/flags.ts#getFlags()`,
  30s-cached — a flip can take up to 30s to propagate). No auth; this is the
  same endpoint the dashboard already polls for env/version.
- **Server-side**: `await isFlagEnabled('some-key')` (`src/services/flags.ts`)
  — `false` for an unknown key, never throws.

## Managing a flag — `/api/breeder/flags` (behind the breeder guard)

| method + path  | body                        | does                                                                                                                                                                                                                                   |
| -------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /`        |                             | every flag: `{ key, enabled, description, updated_at }`                                                                                                                                                                                |
| `PUT /:key`    | `{ enabled, description? }` | create or toggle. `key` must be lowercase letters/digits/hyphens. Omitting `description` keeps the existing one; the cache is invalidated so the next read (server- or client-side) sees the change immediately, not after the 30s TTL |
| `DELETE /:key` |                             | remove the row entirely — same effect as `enabled:false` plus dropping the description                                                                                                                                                 |

Every set/delete is written to the access log (`flags.set` / `flags.delete`).

## What this is for

Gating a Phase 14–21 hardening rollout (or any risky change) behind a flag
that can be flipped off from the dashboard without a deploy — e.g. wrap a new
code path in `if (await isFlagEnabled('...')) { ... } else { /* old path */ }`
server-side, or gate a new UI section on `flags['...']` in the dashboard.
Nothing in this codebase is gated on a flag yet; this is the mechanism, ready
for the next feature that wants a kill switch during its own rollout.

**Not built**: percentage/gradual rollout, per-user or per-kennel targeting.
This deployment is one kennel per instance and flags are a deployment-level
concern (stage a whole instance, not a slice of one kennel's users) — a
canary rollout at that granularity is what the fleet OTA rollout mechanism
(`docs/phase9-fleet.md`) already does for firmware. Add percentage/targeting
here only if a real use case needs gating _within_ one running instance.
