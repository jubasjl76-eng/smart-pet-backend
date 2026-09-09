# Breeding calendar (Phase 6)

The planning layer upstream of litters. A **planned mating is a `litters` row in
status `planned`** — the existing `POST /api/breeder/litters` creates it; this
module adds heat tracking, the mating detail, progesterone guidance, and one
assembled calendar feed. Migration `006` adds `heat_cycles` +
`litters.mating_method` + `litters.progesterone`.

## API — `/api/breeder/breeding` (behind the breeder guard)

### Heat cycles
| method | path | body |
|---|---|---|
| `GET` | `/heat-cycles?animalId=` | list |
| `POST` | `/heat-cycles` | `{ animalId, startedOn, endedOn?, notes? }` |
| `PATCH` | `/heat-cycles/:id` | `startedOn, endedOn, notes` |
| `DELETE` | `/heat-cycles/:id` | |

### Mating detail (on a litter)
| method | path | body / effect |
|---|---|---|
| `POST` | `/litters/:id/mated` | `{ matedOn, method?, progesterone?:[{on,ngml}] }` → sets `mated_on`, `due_on = matedOn + 63`, `mating_method`; `planned` → `expecting` |
| `POST` | `/litters/:id/progesterone` | `{ on, ngml }` → appends the reading, returns `{ progesterone, guidance }` |

`guidance` from a reading (ng/mL, rough): `pre-surge` (<2) · `surge` (<5, ovulation ~2 days, `breedOn`) · `ovulation` (<20, `breedOn` = +2 days) · `post-ovulation` (≥20).

### `GET /calendar`
```jsonc
{
  "heats": [{ damId, name, lastHeat, predictedNextHeat, intervalDays,
              fertileWindow: { from, to } | null }],
  "litters": [{ id, name, status, mated_on, due_on, whelped_at, dam_name, sire_name }],
  "goHome": [{ id, name, go_home_on, litter_name }]
}
```
`predictedNextHeat` = last season + the average of the recent inter-season gaps
(180 days until there are two seasons on record). `fertileWindow` = days 9 to 15
from the predicted start.

## Sweep

`breedingSweep()` runs each engine tick:
- **`heat-due`** (info) — a dam whose predicted next season is within 7 days (dedup `heat-due:<animalId>:<date>`).
- **`whelping-soon`** (warning) — a litter with `due_on` in `[today-3, today+5]` and no `whelped_at` (dedup `whelping-soon:<litterId>`).

Whelp confirmation is unchanged: `POST /api/breeder/litters/:id/whelp`.

## Console (Cursor's Phase 6 task)

- **Calendar view** — one timeline of predicted seasons, fertile windows,
  planned/confirmed matings, due dates, go-home dates (from `/calendar`).
- **Heat log** per dam; a **"record mating"** action on a planned litter
  (date + method + progesterone readings) that shows the guidance.
