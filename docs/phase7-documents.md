# Documents & paperwork (Phase 7, slice 1)

Storage abstraction + document uploads + pedigree. Slice 2 adds generated sale
docs (contract / receipt / guarantee) and the microchip hand-off record.

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

## Console (Cursor's Phase 7 task)

- a **Documents** section per animal / puppy / buyer — drag-drop upload with a
  `kind` picker, list with download / delete.
- a **pedigree** view on the animal drawer (3–4 gen tree from `/pedigree`), with
  a link to each ancestor's registration document.
