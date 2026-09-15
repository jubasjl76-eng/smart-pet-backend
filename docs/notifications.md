# Notifications (Phase 4)

Alerts (`exceptions`) fan out to people through per-user channel preferences and
an escalation chain. The engine (`src/breeder/engine/notifier.ts`) runs on the
sweep timer: `runEscalations()` queues steps that have come due, then
`drainNotifications()` delivers queued rows.

## Channels

| channel   | adapter                                                                                                  | needs                                                    |
| --------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `log`     | console                                                                                                  | —                                                        |
| `webhook` | HTTP POST to the recipient's `webhook_url`                                                               | — (per-recipient target)                                 |
| `email`   | Resend REST API                                                                                          | `RESEND_API_KEY`, `NOTIFY_EMAIL_FROM`                    |
| `sms`     | Twilio REST API                                                                                          | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` |
| `siren`   | MQTT `relay` command (`{command:'relay', params:{action:'pulse', ms:5000}}`) to the step's target device | broker reachable                                         |
| `push`    | not wired                                                                                                | —                                                        |

Un-configured provider channels return `suppressed` (with the reason in
`notifications.error`), never `failed`.

`email`/`sms` are wrapped in a circuit breaker (`opossum`, Phase 20, A12 #5,
`src/circuitBreaker.ts`) — after repeated Resend/Twilio failures the breaker
opens and further sends fail fast (no network attempt) until it probes again;
an open-circuit rejection looks like any other delivery failure to the caller
above, so it flows into the same retry/backoff queue. State is on `/metrics`
as `circuit_breaker_state{name="resend"|"twilio"}`.

## Retry

A `failed` attempt is re-queued with exponential backoff — 60s, 300s, 1500s, …
capped at 6h — until `notifications.max_attempts` (default 5), then `failed`.
`sent` / `suppressed` are terminal. `provider_ref` holds the Resend/Twilio id.

Migration `003_notifications_delivery.sql` adds `next_attempt_at`,
`max_attempts`, `provider_ref`.

**Not on the `pg-boss` job queue (Phase 20, A12 #3).** `notifications` is
already a transactional-outbox-shaped table — queued rows, a backoff-driven
`next_attempt_at`, a terminal `failed` state — drained by the same
leader-locked engine tick that Phase 20 introduced specifically to stop
sweeps from double-running past one instance. Moving delivery onto `pg-boss`
would mean re-deriving that already-working, tested retry logic to fit its
own retry model, and would change the synchronous "run now" contract several
ops endpoints rely on (`POST /update-pack/run`, `POST /retention/run`, the
engine-tick "run notifications now" path) for a mostly architectural win at
this project's scale. `pg-boss` was introduced instead for the workload that
genuinely needed a durable, safely-concurrent-dequeue worker with a real
dead-letter queue: fleet OTA fan-out (`docs/phase9-fleet.md`). Update-pack /
weekly buyer emails (`updatePackSweep()`, `docs/phase5-buyer-comms.md`)
already deliver through this same `notifications` table, so they inherit
whatever this mechanism does without any change of their own.

## API — for the console (Phase 4 dashboard task)

### `GET /api/breeder/ops/notification-channels`

```jsonc
{
  "channels": {
    "log": true,
    "webhook": true,
    "email": false,
    "sms": false,
    "siren": true,
    "push": false,
  },
}
```

Use it to grey out channels the deployment can't send on yet.

### `GET /api/breeder/ops/notification-prefs` → `{ prefs: Row | null }`

### `PUT /api/breeder/ops/notification-prefs`

Body (camelCase; whole object replaces the row):

```jsonc
{
  "channels": ["log", "email", "sms"],
  "quietHours": {
    "start": "22:00",
    "end": "07:00",
    "tz": "Europe/Dublin",
    "overrideSeverity": "critical",
  },
  "escalation": [
    { "afterSeconds": 300, "channel": "sms", "target": "+15550001234" },
    { "afterSeconds": 900, "channel": "siren", "target": "hub-kitchen" },
    { "afterSeconds": 1800, "channel": "webhook", "target": "https://hooks.slack.com/…" },
  ],
  "webhookUrl": "https://…",
  "smsNumber": "+1…",
  "email": "me@…",
}
```

`escalation` is an ordered list — each step fires once, `afterSeconds` after the
exception was first notified, if it's still unresolved. `target` is the address
for that step's channel (URL / phone / device id).

## Delivery history

`notifications` rows are already surfaced per-exception (`GET /api/breeder/inbox/:id`
→ `notifications[]`). Fields the console can show: `channel`, `status`
(`queued` / `sent` / `failed` / `suppressed`), `attempts`, `error`, `sent_at`.
