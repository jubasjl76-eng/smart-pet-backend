# Buyer communications (Phase 5, slice 2)

Broadcasts, direct messages, and the weekly puppy **update pack**. Everything
goes out through the Phase 4 notifier — `email` when the buyer has an address,
otherwise `log`. Migration `005` adds `buyer_messages` + `update_pack_subscriptions`.

## API — `/api/breeder/buyers` (behind the breeder guard)

| method | path | body / notes |
|---|---|---|
| `POST` | `/messages/broadcast` | `{ subject, body, litterId?, status? }` → one message per matching buyer (`wants_litter_id = litterId` and/or `status`). `{name}` in the body is replaced with the buyer's first name. Returns `{ sent }`. |
| `POST` | `/messages/:buyerId` | `{ subject, body }` → one direct message |
| `GET` | `/messages` | `?buyerId=` / `?litterId=` — sent log, each row carries `buyer_name` + `delivery_status` (from the linked notification) |
| `GET` | `/update-pack/subscriptions` | all subs with buyer + puppy names |
| `POST` | `/update-pack/subscribe` | `{ buyerId, puppyId }` — upsert; re-subscribing reactivates |
| `PATCH` | `/update-pack/subscriptions/:id` | `{ active: boolean }` |
| `POST` | `/update-pack/run` | run the sweep now (also runs on the engine timer) |
| `GET` | `/puppies/:pupId/go-home-pack` | assembled: puppy identity + microchip + litter/parents + buyer + weight series + **given** vaccination records + photos + `documents: []` (Phase 7). Structured JSON the console renders / prints. |

## Update-pack sweep

`updatePackSweep()` runs each engine tick. For every `active` subscription whose
`next_run_at` has passed: it renders a plain-text pack (puppy name, age in weeks,
latest weight + daily gain, photo URLs, go-home date), queues a `notifications`
row, writes a `buyer_messages` row (`kind = 'update-pack'`), and pushes
`next_run_at` a week out (`last_sent_at = now`).

## Console (Cursor's Phase 5 task, part 2)

- **Buyer messaging**: on the Buyers page — a "message" action per buyer, and a
  "broadcast" composer (pick a litter and/or a status, subject + body, `{name}`
  token). Show the `/messages` log.
- **Update pack**: a toggle per reserving buyer to start/stop the weekly send;
  show `last_sent_at` / `next_run_at`.
- **Go-home pack**: a printable view of `/puppies/:pupId/go-home-pack`.
