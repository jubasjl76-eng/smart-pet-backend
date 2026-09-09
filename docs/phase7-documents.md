# Documents & paperwork (Phase 7)

Slice 1: storage abstraction + document uploads + pedigree.
Slice 2: generated sale docs (contract / deposit receipt / health guarantee)
and the microchip hand-off record, from editable templates.

## Storage (`src/services/storage.ts`)

One interface: `put(key, buffer, contentType?)`, `get(key)`, `remove(key)`.
`getStorage()` returns the driver from `STORAGE_DRIVER` (`local`, default) writing
under `STORAGE_DIR` (`./data/uploads`, git-ignored). Keys are
`<kennelId>/<uuid>-<filename>`; a key that escapes the root is rejected. An S3
driver slots in behind the same interface for Phase 10.

## `POST /api/breeder/documents` (multipart, behind the breeder guard)

Field `file` (≤ 15 MB) plus text fields:

| field | notes |
|---|---|
| `kind` | `registration \| contract \| receipt \| guarantee \| certificate \| handoff \| photo \| other` (default `other`) |
| `subjectType` | `animal \| puppy \| buyer \| litter` |
| `subjectId` | the id of that subject |
| `title` | defaults to the filename |

Returns the `document` row (no bytes).

## `GET /api/breeder/documents`

`?subjectType=` `?subjectId=` `?kind=` — metadata list, newest first. Each row
carries `generated` (true for text-only docs). `size_bytes`, `content_type`,
`filename` included.

## `GET /api/breeder/documents/:id/download`

Streams the file (`Content-Disposition: inline`), or the markdown body for a
generated doc. 410 if the file is missing from storage.

## `DELETE /api/breeder/documents/:id`

Removes the row and the stored file.

## `GET /api/breeder/animals/:id/pedigree?generations=4`

Recursive sire/dam walk (1–5 generations, default 4). Returns a tree:
`{ id, name, sex, breed, registrationNo, sire: node|null, dam: node|null }`.
Cycle-safe. Registration papers are just `documents` rows with
`kind='registration'`, `subjectType='animal'`.

## Slice 2 — generated paperwork

Four built-in templates, plain text with `{{token}}` placeholders (slug / kind):
`contract` / contract, `deposit-receipt` / receipt, `health-guarantee` /
guarantee, `microchip-handoff` / handoff. A kennel can edit any of them; the
edit is stored in `document_templates (kennel_id, slug)` and overlaid on the
default. Migration `008_document_templates.sql`.

### `GET /api/breeder/documents/templates`

Defaults with this kennel's edits applied. Each row: `slug`, `kind`, `title`,
`body`, `customised`, `tokens` (the `{{token}}` names in the body).

### `PUT /api/breeder/documents/templates/:slug`

Body `{ body, title? }`. Upserts the kennel override. `slug` must be one of the
four known slugs. Returns the stored template + `tokens`.

### `POST /api/breeder/documents/generate`

Body `{ template, subjectType, subjectId, tokens? }`. Resolves the template
(override or default), auto-fills tokens from the subject, applies `tokens` from
the request on top (request wins), renders, and stores the result as a
`documents` row (`body` set, `storage_key` null, `kind` from the template,
`meta.template` + `meta.tokens`). Returns `{ document, body }`.

Auto-filled tokens: `today`, `kennel_name` always; for `subjectType='puppy'`:
`puppy_name` `puppy_sex` `puppy_color` `microchip` `go_home_on` `breed`
`birth_date` `dam_name` `sire_name` `buyer_name` `buyer_email`; for
`subjectType='buyer'`: `buyer_name` `buyer_email`. Everything else
(`price` `deposit` `balance`, and any token for a `litter` / `animal` subject)
must be passed in `tokens`. A token left with no value is a hard `400`
(`missing token(s): price, deposit`) rather than a blank in a signed document.

The rendered doc is fetched back through the slice-1
`GET /api/breeder/documents/:id/download` (returns the markdown body).

### Go-home pack

`GET /api/breeder/buyers/puppies/:pupId/go-home-pack` now returns `documents`:
every `documents` row for that puppy or its buyer (`id`, `kind`, `title`,
`filename`, `generated`, `created_at`), newest first. Was `[]`.

## Console (Cursor's Phase 7 task)

- a **Documents** section per animal / puppy / buyer — drag-drop upload with a
  `kind` picker, list with download / delete.
- a **pedigree** view on the animal drawer (3-4 gen tree from `/pedigree`), with
  a link to each ancestor's registration document.
- a **Generate** action on a puppy / buyer: pick a template, fill the tokens it
  lists (`GET /templates` gives the `tokens` array; auto ones can be left
  blank), `POST /generate`, then offer the download. A template editor screen
  backed by `GET` / `PUT /templates/:slug`.
