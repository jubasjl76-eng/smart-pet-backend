# API versioning

Hardening Phase 14 (A1).

## The scheme

URL-path versioning. The current version is **`v1`**:

```
https://api.smartpet.example/api/v1/breeder/animals
```

Bare `/api/*` (no `/v1`) is a **deprecated alias** for the transition window. It
still routes to the same handlers, but every response carries:

```
Deprecation: true
Sunset: Fri, 01 Jan 2027 00:00:00 GMT
Link: </docs>; rel="describedby"
```

`/api/config` is exempt (it is a meta endpoint, not part of the versioned API).

## Rules

- **Breaking change → new version.** Removing a field, renaming one, changing a
  type, tightening validation, or changing status-code semantics. Ship it under
  `/api/v2/*`; `/api/v1/*` keeps working until its own sunset.
- **Non-breaking → same version.** Adding an optional field, a new endpoint, a
  new enum value clients can ignore, relaxing validation.
- A version is supported for **at least 6 months** after its successor ships and
  its `Sunset` header appears. The date moves out, never in.
- After a version's `Sunset` date, requests to it get `410 Gone` with a `Link`
  to the migration notes.

## The spec

`GET /openapi.json` is the machine-readable contract; `GET /docs` renders it
(Scalar). Routes are migrated onto the zod-backed registry file-by-file —
anything not yet in `/openapi.json` is still served but not yet documented or
covered by generated clients.

## Traffic contract (documented now, enforced in Phase 20)

- `429 Too Many Requests` carries `Retry-After` + `RateLimit-Limit` /
  `-Remaining` / `-Reset`. Clients back off with jittered exponential backoff.
- Mutating endpoints honour an `Idempotency-Key` request header.
- List endpoints paginate with `?cursor=` + `?limit=` (max 200).
