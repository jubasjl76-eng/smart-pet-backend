# Vaccinations & worming (Phase 5, slice 1)

Health records the go-home pack depends on. Certificate = a URL for now; real
file upload lands with Phase 7's storage abstraction.

## Schema (migration `004`)

- **`vaccination_protocols`** — `{ id, kennel_id, name, species, doses: [{name, atAgeDays, kind}], is_default }`.
  Seed installs one `is_default` protocol ("Core puppy schedule") per kennel.
- **`vaccination_records`** — `{ id, kennel_id, animal_id | puppy_id, protocol_id?, name, kind: vaccine|worming, due_on, given_on, batch_no, vet_name, certificate_url, notes }`.

## API — `/api/breeder/vaccinations` (behind the breeder guard)

| method | path | body / notes |
|---|---|---|
| `GET` | `/protocols` | all protocols, default first |
| `POST` | `/protocols` | `{ name, doses:[{name,atAgeDays,kind?}], species?, isDefault? }` |
| `PATCH` | `/protocols/:id` | any of `name, species, doses, isDefault` |
| `DELETE` | `/protocols/:id` | |
| `POST` | `/apply` | `{ protocolId? (else the default), doses?, animalId? \| puppyId? \| litterId? }` → expands the protocol against the subject's birth date into `vaccination_records`, skipping names already present. `litterId` applies to every puppy. Returns `{ created, subjects }`. Subjects with no birth date are skipped. |
| `GET` | `/` | `?animalId=` / `?puppyId=` / `?status=done\|due\|overdue\|upcoming`. Each record carries a computed `status`. |
| `PATCH` | `/:id` | mark given / edit: `givenOn, batchNo, vetName, certificateUrl, notes, dueOn, name, kind` |
| `POST` | `/sweep` | on-demand overdue sweep (also runs on the engine timer) |

**Status:** `done` (given), `overdue` (due date passed), `due` (within 7 days),
`upcoming` (later or no due date).

## Sweep

`vaccinationSweep()` runs each engine tick: any subject with ≥1 record where
`given_on IS NULL AND due_on < today` gets **one** `vaccination-due` care-inbox
item (`dedup_key = vaccination-due:<subjectId>`, severity `warning`,
`notifyAudience: manager`), listing the overdue names and the oldest due date.

## Console (Cursor's Phase 5 task)

- a **Vaccinations** view: per animal/puppy, the record list grouped by status,
  a "mark given" action (batch no + vet + cert URL), and an "apply protocol"
  button (pick a protocol / the default, or a litter).
- a **Protocols** editor (list of doses: name · age in days · vaccine/worming).
- surface `overdue` count somewhere near the care inbox.
