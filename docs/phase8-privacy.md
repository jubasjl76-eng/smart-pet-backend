# Privacy & data-governance (Phase 8)

Slice 1: access log.
Slice 2: retention windows + sweep, GDPR export / delete.

## Access log (`009_access_log.sql`)

`access_log` is append-only: one row per read of sensitive data.

| column | notes |
|---|---|
| `id` | `BIGSERIAL` |
| `kennel_id` | tenant |
| `user_id` | the caller, null for unauthenticated paths |
| `action` | `document.download` now; `camera.view`, `door.open`, `privacy.export` planned |
| `subject_type` / `subject_id` | what was read. `subject_id` is text, not UUID (device ids). For a document download this is the document's own subject (buyer / puppy / ...), so "everything touching buyer X" is one query |
| `ip` | first hop of `x-forwarded-for`, else socket address |
| `detail` | JSONB, e.g. `{ documentId, kind, generated }` |
| `at` | timestamp |

Indexes: `(kennel_id, at DESC)`, `(subject_type, subject_id)`.

## Writing to it — `logAccess(req, action, { subjectType?, subjectId?, detail? })`

`src/breeder/accessLog.ts`. Call it from a handler once the read is
authorised. It never throws: an audit-write failure is logged to the console
and swallowed so it cannot break the request it is auditing.

Wired now: `GET /api/breeder/documents/:id/download`. When the camera/door read
endpoints land (Phase 9/10) each gets one `logAccess(req, 'camera.view', ...)`
line the same way.

## `GET /api/breeder/privacy/access-log`

Behind the breeder guard. Filters (all optional, AND-ed):

| query | matches |
|---|---|
| `action` | exact |
| `subjectType` / `subjectId` | exact |
| `userId` | exact |
| `since` / `until` | `at >=` / `at <=` (ISO timestamp) |
| `limit` | default 200, max 1000 |

Returns `{ entries: [...] }`, newest first.

## Retention (`010_retention.sql`)

`retention_settings (kennel_id, data_class, keep_days)`. **No row = keep
forever** (the safe default). The engine's `retentionSweep` only touches a class
that has a row with `keep_days >= 1`.

Classes: `access_log` (deletes `access_log` rows older than the window),
`document` (deletes `documents` rows older than `created_at + window`, and their
stored files, 500 per tick).
ponytail: one window for all document kinds; split into `document.contract` /
`document.certificate` if the breeder needs different windows (a contract is
often a 6-year legal keep).

Buyer / animal / litter records are **not** on an automatic timer. Their
removal is the explicit erasure path below.

### `GET /api/breeder/privacy/retention`

`{ classes: [{ dataClass, keepDays, updatedAt }] }`. `keepDays: null` = off.

### `PUT /api/breeder/privacy/retention/:class`

Body `{ keepDays }`. `keepDays < 1` deletes the row (turns retention off for
that class). `:class` must be `access_log` or `document`.

### `POST /api/breeder/privacy/retention/run`

Runs the sweep now. Returns `{ accessLog, documents }` (counts removed). Also on
the engine tick.

## GDPR export — `GET /api/breeder/privacy/export?subjectType=&id=`

`subjectType`: `buyer` | `animal` | `litter`. Owner data lives in the
pet-owner app (not built yet) so `owner` returns 400. Returns one JSON bundle:

| subject | bundle |
|---|---|
| `buyer` | the buyer row, `buyer_messages`, `update_pack_subscriptions`, their `puppies` (summary), `documents`, `access_log` entries touching them |
| `animal` | the animal row, `weight_readings`, `vaccination_records`, `heat_cycles`, `litters` it parents, `documents` |
| `litter` | the litter row, `puppies`, waitlist `buyers`, `documents` |

Logged as `privacy.export`.

## GDPR delete (erasure) — `POST /api/breeder/privacy/delete`

Body `{ subjectType, id, confirm: true }`. Without `confirm: true` → 400.

| subject | effect | refuses (409) when |
|---|---|---|
| `buyer` | detaches their puppies (`puppies.buyer_id = NULL`, inventory kept), deletes the buyer (messages + subscriptions cascade) and their `documents` + files | never |
| `animal` | deletes the animal (weights, vaccination records, heat cycles cascade) and its `documents` + files | it is `dam_id` / `sire_id` on any litter |
| `litter` | deletes the litter (puppies cascade) and its `documents` + files | any puppy is `reserved` / `sold` / `kept` |

Returns `{ ok: true, deleted: { <table>: n } }`. Logged as `privacy.delete`
with the counts in `detail`.

## Console (Cursor's Phase 8 task)

A **Data & privacy** admin screen:

- access-log viewer: table backed by `GET /privacy/access-log`, with the
  filters above (action dropdown, subject search, user, date range).
- a per-subject panel: "export" downloads the JSON bundle from
  `GET /privacy/export`; "delete" POSTs to `/privacy/delete` with
  `confirm: true` behind a typed confirmation, and surfaces the 409 refusal
  reason.
- retention settings form: `GET` / `PUT /privacy/retention/:class` for
  `access_log` and `document` (a number field, empty = off).
