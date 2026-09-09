# Public marketing site (Phase 3 · A6)

Serves `smart-pet-website`. The canonical response contract lives in that repo
(`docs/public-api.md`); this note covers the backend side.

## Migration `002_public_website.sql`

Adds, idempotently:

| table | columns |
|---|---|
| `animals` | `published bool`, `photos jsonb`, `titles text`, `bio text`, `health_tests jsonb` |
| `litters` | `published bool`, `photos jsonb`, `public_description text` |
| `puppies` | `published bool`, `photos jsonb`, `color varchar` |
| `kennels` | `public_tagline`, `public_about`, `public_email`, `public_phone`, `public_location`, `public_socials jsonb` |
| `buyers` | `source varchar` (`'website'` for site inquiries) |

Partial indexes on `published` for the read path.

## `/api/public/*` — read-only, no auth (`src/breeder/routes/public.ts`)

Only rows with `published = true`. Single-kennel (the first `kennels` row).

- `GET /kennel` — public identity + distinct published breeds
- `GET /dogs` — `animals` where `published AND role IN ('breeding','retired')`; `role` in the response is derived from `sex` (`male→sire`, `female→dam`)
- `GET /litters` / `GET /litters/:id` — published litters with embedded published puppies + weight series. `status` is derived by `deriveLitterStatus()` (unit-tested)
- `POST /inquiries` — `{name, email, phone?, message?, puppyId?, litterId?}` → a `buyers` row (`status='waitlist'`, `source='website'`) + a low-priority `website-inquiry` care-inbox item. In-memory rate limit, 5/hour/IP. **Never** changes puppy/litter status.

## `/api/breeder/website/*` — console controls (behind the breeder guard)

Called by the dashboard's "Publish to website" screen (task A7):

- `GET /` — current `public_*` fields + published counts
- `GET /inventory` — every publishable animal/litter/puppy with its publish + photo state
- `PUT /kennel` — set `public_tagline/about/email/phone/location/socials`
- `PATCH /:kind/:id` — `kind ∈ animal|litter|puppy`; body may carry `published`, `photos`, `titles`/`bio`/`healthTests` (animal), `publicDescription` (litter), `color` (puppy)

A `published` change fires `fireRevalidate()` — a fire-and-forget POST to
`WEBSITE_REVALIDATE_URL` with `WEBSITE_REVALIDATE_SECRET` (both optional; no-op
when unset).

## Seed

`SEED_DEMO=true` publishes the demo dam + sire and creates one published litter
(3 puppies + weight readings) plus the kennel's `public_*` fields, so a fresh
`docker compose up` shows a small live site with no manual steps.
