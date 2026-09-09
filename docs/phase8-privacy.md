# Privacy & data-governance (Phase 8)

Slice 1: access log.
Slice 2 (pending): retention windows + sweep, GDPR export / delete.

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

## Console (Cursor's Phase 8 task)

A **Data & privacy** admin screen:

- access-log viewer: table backed by `GET /privacy/access-log`, with the
  filters above (action dropdown, subject search, user, date range).
- (slice 2) a per-subject panel: "export" downloads the JSON bundle, "delete"
  runs the erasure with a typed confirmation.
- (slice 2) retention settings form.
