import { Router } from 'express';
import { z } from '@jubasjl76-eng/shared';
import { query, queryOne, execute } from '../../database/index.js';
import { ah, bad } from '../http.js';
import { apiRoute } from '../../openapi/index.js';
import { consumableStatus, estimateDailyUse } from '../logic/consumables.js';
import { predictMaintenance, type HealthCounter } from '../logic/maintenance.js';
import { generateRotation } from '../logic/enrichment.js';
import { raiseException } from '../exceptions.js';
import { publishCommand } from '../../services/feederMqtt.js';
import { channelConfigured } from '../engine/channels.js';

const router = Router();
const T = ['breeder: ops'];

// ══ Consumables (warn, do not auto-order) ═════════════════════════════════
router.get(
  '/consumables',
  apiRoute({
    method: 'get', path: '/api/breeder/ops/consumables', tags: T, secure: true,
    summary: 'Consumables with usage estimate + stock status.',
    responses: { 200: { description: 'ok', schema: z.object({ consumables: z.array(z.record(z.string(), z.unknown())) }) } },
  }),
  ah(async (req, res) => {
  const rows = await query<any>(`SELECT * FROM consumables WHERE kennel_id=$1 ORDER BY category, name`, [req.kennelId]);
  const out = await Promise.all(rows.map(async (c) => {
    let dailyUse = c.daily_use ?? null;
    if (c.linked_device_id) {
      const events = await query<{ grams: number | null; occurred_at: string }>(
        `SELECT grams_dispensed AS grams, occurred_at FROM intake_events
          WHERE device_id=$1 AND occurred_at > NOW() - INTERVAL '14 days' ORDER BY occurred_at`,
        [c.linked_device_id]
      );
      dailyUse = estimateDailyUse(events.map((e) => ({ grams: e.grams, at: e.occurred_at })), c.daily_use ?? null);
    }
    const status = consumableStatus({ onHand: c.on_hand, lowThreshold: c.low_threshold, dailyUse });
    return { ...c, estimatedDailyUse: dailyUse, status };
  }));
  res.json({ consumables: out });
}),
);

router.post(
  '/consumables',
  apiRoute({
    method: 'post', path: '/api/breeder/ops/consumables', tags: T, secure: true,
    summary: 'Add a consumable to track.',
    request: {
      body: z.object({
        name: z.string().min(1),
        category: z.string().optional(),
        unit: z.string().optional(),
        onHand: z.coerce.number().optional(),
        lowThreshold: z.coerce.number().optional(),
        dailyUse: z.coerce.number().nullable().optional(),
        linkedDeviceId: z.string().nullable().optional(),
        linkedFoodSku: z.string().nullable().optional(),
      }),
    },
    responses: { 201: { description: 'created' } },
  }),
  ah(async (req, res) => {
  const b = req.body;
  const row = await queryOne(
    `INSERT INTO consumables (kennel_id, name, category, unit, on_hand, low_threshold, daily_use, linked_device_id, linked_food_sku)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [req.kennelId, b.name, b.category ?? 'food', b.unit ?? 'kg', b.onHand ?? 0, b.lowThreshold ?? 0,
     b.dailyUse ?? null, b.linkedDeviceId ?? null, b.linkedFoodSku ?? null]
  );
  res.status(201).json({ consumable: row });
}),
);

router.patch(
  '/consumables/:id',
  apiRoute({
    method: 'patch', path: '/api/breeder/ops/consumables/{id}', tags: T, secure: true,
    summary: 'Update a consumable (partial).',
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: 'ok' }, 404: { description: 'not found' } },
  }),
  ah(async (req, res) => {
  const camel: Record<string, string> = { onHand: 'on_hand', lowThreshold: 'low_threshold', dailyUse: 'daily_use', linkedDeviceId: 'linked_device_id', linkedFoodSku: 'linked_food_sku' };
  const allowed = ['name', 'category', 'unit', 'on_hand', 'low_threshold', 'daily_use', 'linked_device_id', 'linked_food_sku'];
  const sets: string[] = []; const vals: unknown[] = [req.params.id, req.kennelId];
  for (const [k, v] of Object.entries(req.body)) {
    const col = camel[k] ?? k;
    if (allowed.includes(col)) { vals.push(v); sets.push(`${col} = $${vals.length}`); }
  }
  if (!sets.length) return bad(res, 'No updatable fields');
  const row = await queryOne(`UPDATE consumables SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$1 AND kennel_id=$2 RETURNING *`, vals);
  if (!row) return bad(res, 'Consumable not found', 404);
  res.json({ consumable: row });
}),
);

/** Sweep consumables and raise an exception for anything low/critical/out. */
router.post(
  '/consumables/sweep',
  apiRoute({
    method: 'post', path: '/api/breeder/ops/consumables/sweep', tags: T, secure: true,
    summary: 'Raise an exception for any low / critical / out consumable.',
    responses: { 200: { description: 'ok', schema: z.object({ raised: z.number() }) } },
  }),
  ah(async (req, res) => {
  const rows = await query<any>(`SELECT * FROM consumables WHERE kennel_id=$1`, [req.kennelId]);
  let raised = 0;
  for (const c of rows) {
    const status = consumableStatus({ onHand: c.on_hand, lowThreshold: c.low_threshold, dailyUse: c.daily_use ?? null });
    if (status.level === 'ok') continue;
    await raiseException({
      kennelId: req.kennelId!, kind: 'consumable-low',
      severity: status.level === 'out' || status.level === 'critical' ? 'critical' : 'warning',
      title: `${c.name} ${status.level === 'out' ? 'out of stock' : 'running low'}`,
      detail: status.message, dedupKey: `consumable-low:${c.id}`,
      suggestedAction: 'Buy more and update the on-hand count', notifyAudience: 'manager',
    });
    raised++;
  }
  res.json({ raised });
}),
);

// ══ Predictive maintenance ════════════════════════════════════════════════
router.get(
  '/maintenance',
  apiRoute({
    method: 'get', path: '/api/breeder/ops/maintenance', tags: T, secure: true,
    summary: 'Device health counters + maintenance predictions.',
    responses: { 200: { description: 'ok', schema: z.object({ devices: z.array(z.record(z.string(), z.unknown())) }) } },
  }),
  ah(async (req, res) => {
  const rows = await query<any>(
    `SELECT h.*, d.name AS device_name, d.device_type
       FROM device_health_counters h
       LEFT JOIN devices d ON d.device_id = h.device_id
      WHERE h.kennel_id=$1 ORDER BY h.device_id, h.metric`,
    [req.kennelId]
  );
  const byDevice: Record<string, any> = {};
  for (const r of rows) {
    const pred = predictMaintenance({
      metric: r.metric, value: r.value, serviceLimit: r.service_limit, servicedAt: r.serviced_at,
    } as HealthCounter);
    (byDevice[r.device_id] ??= { deviceId: r.device_id, name: r.device_name, type: r.device_type, metrics: [] })
      .metrics.push({ ...r, prediction: pred });
  }
  res.json({ devices: Object.values(byDevice) });
}),
);

router.put(
  '/maintenance/:deviceId/:metric/limit',
  apiRoute({
    method: 'put', path: '/api/breeder/ops/maintenance/{deviceId}/{metric}/limit', tags: T, secure: true,
    summary: 'Set the service limit for a device metric.',
    request: {
      params: z.object({ deviceId: z.string(), metric: z.string() }),
      body: z.object({ serviceLimit: z.coerce.number() }),
    },
    responses: { 200: { description: 'ok' } },
  }),
  ah(async (req, res) => {
  await execute(
    `INSERT INTO device_health_counters (kennel_id, device_id, metric, value, service_limit)
     VALUES ($1,$2,$3,0,$4)
     ON CONFLICT (device_id, metric) DO UPDATE SET service_limit=EXCLUDED.service_limit, updated_at=NOW()`,
    [req.kennelId, req.params.deviceId, req.params.metric, req.body.serviceLimit]
  );
  res.json({ ok: true });
}),
);

/** Mark a component serviced: reset the counter and clear open maintenance exceptions. */
router.post(
  '/maintenance/:deviceId/:metric/serviced',
  apiRoute({
    method: 'post', path: '/api/breeder/ops/maintenance/{deviceId}/{metric}/serviced', tags: T, secure: true,
    summary: 'Mark a component serviced (resets counter, clears exceptions).',
    request: { params: z.object({ deviceId: z.string(), metric: z.string() }) },
    responses: { 200: { description: 'ok' } },
  }),
  ah(async (req, res) => {
  await execute(
    `UPDATE device_health_counters SET value=0, serviced_at=NOW(), updated_at=NOW()
      WHERE device_id=$1 AND metric=$2 AND kennel_id=$3`,
    [req.params.deviceId, req.params.metric, req.kennelId]
  );
  await execute(
    `UPDATE exceptions SET status='resolved', resolved_at=NOW(), resolution_note='serviced'
      WHERE kennel_id=$1 AND device_id=$2 AND kind='maintenance-due' AND status IN ('open','snoozed','escalated')`,
    [req.kennelId, req.params.deviceId]
  );
  res.json({ ok: true });
}),
);

// ══ Emergency mode ════════════════════════════════════════════════════════
router.get(
  '/emergency/status',
  apiRoute({
    method: 'get', path: '/api/breeder/ops/emergency/status', tags: T, secure: true,
    summary: 'Current emergency state + last event.',
    responses: { 200: { description: 'ok' } },
  }),
  ah(async (req, res) => {
  const k = await queryOne(
    `SELECT emergency_state, emergency_mode, emergency_since FROM kennels WHERE slug=$1`, [req.kennelId]
  );
  const last = await queryOne(
    `SELECT * FROM emergency_events WHERE kennel_id=$1 ORDER BY started_at DESC LIMIT 1`, [req.kennelId]
  );
  res.json({ kennel: k, lastEvent: last });
}),
);

/** Evacuation manifest: pen → animals → owner/vet contacts. Printed / pushed to staff phones. */
router.get(
  '/emergency/manifest',
  apiRoute({
    method: 'get', path: '/api/breeder/ops/emergency/manifest', tags: T, secure: true,
    summary: 'Evacuation manifest: pen → animals → contacts.',
    responses: { 200: { description: 'ok' } },
  }),
  ah(async (req, res) => {
  const rows = await query(
    `SELECT p.name AS pen, p.id AS pen_id,
            a.name AS animal, a.microchip, a.collar_device_id,
            cp.vet_name, cp.vet_phone, cp.emergency_contact, cp.emergency_phone
       FROM pens p
       LEFT JOIN animals a ON a.current_pen_id = p.id AND a.status='active'
       LEFT JOIN care_plans cp ON cp.animal_id = a.id
      WHERE p.kennel_id=$1
      ORDER BY p.name, a.name`,
    [req.kennelId]
  );
  res.json({ manifest: rows, generatedAt: new Date().toISOString() });
}),
);

router.post(
  '/emergency/trigger',
  apiRoute({
    method: 'post', path: '/api/breeder/ops/emergency/trigger', tags: T, secure: true,
    summary: 'Trigger emergency mode (fans out door unlocks).',
    request: {
      body: z.object({
        mode: z.enum(['fire', 'flood', 'evac', 'drill']).optional(),
        note: z.string().nullable().optional(),
      }),
    },
    responses: { 200: { description: 'ok' }, 400: { description: 'invalid mode' } },
  }),
  ah(async (req, res) => {
  const mode = req.body?.mode ?? 'evac';
  if (!['fire', 'flood', 'evac', 'drill'].includes(mode)) return bad(res, 'Invalid mode');

  await execute(
    `UPDATE kennels SET emergency_state='active', emergency_mode=$2, emergency_since=NOW() WHERE slug=$1`,
    [req.kennelId, mode]
  );

  // Fan out: unlock every pen door (best-effort — MQTT may be down).
  const doors = await query<{ door_device_id: string; name: string }>(
    `SELECT door_device_id, name FROM pens WHERE kennel_id=$1 AND door_device_id IS NOT NULL`, [req.kennelId]
  );
  const actions: Array<{ door: string; ok: boolean; error?: string }> = [];
  for (const d of doors) {
    try {
      await publishCommand(req.kennelId!, d.door_device_id, {
        command: 'door', params: { action: mode === 'drill' ? 'noop' : 'unlock', reason: `emergency:${mode}` },
        deviceId: d.door_device_id, kennelId: req.kennelId, timestamp: Date.now(),
      });
      actions.push({ door: d.name, ok: true });
    } catch (e) {
      actions.push({ door: d.name, ok: false, error: (e as Error).message });
    }
  }

  const evt = await queryOne(
    `INSERT INTO emergency_events (kennel_id, mode, triggered_by, actions, note)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.kennelId, mode, req.user?.id ?? null, JSON.stringify({ doors: actions }), req.body?.note ?? null]
  );

  if (mode !== 'drill') {
    await raiseException({
      kennelId: req.kennelId!, kind: 'emergency', severity: 'critical', priority: 100,
      title: `EMERGENCY: ${mode.toUpperCase()} activated`,
      detail: `Doors: ${actions.filter((a) => a.ok).length}/${doors.length} unlocked`,
      suggestedAction: 'Execute the evacuation plan. Manifest at /api/breeder/ops/emergency/manifest',
      dedupKey: `emergency:${req.kennelId}`, notifyAudience: 'all',
    });
  }
  res.json({ event: evt, doorActions: actions });
}),
);

router.post(
  '/emergency/end',
  apiRoute({
    method: 'post', path: '/api/breeder/ops/emergency/end', tags: T, secure: true,
    summary: 'End emergency mode + resolve its exceptions.',
    responses: { 200: { description: 'ok' } },
  }),
  ah(async (req, res) => {
  await execute(
    `UPDATE kennels SET emergency_state='normal', emergency_mode=NULL, emergency_since=NULL WHERE slug=$1`,
    [req.kennelId]
  );
  await execute(
    `UPDATE emergency_events SET ended_at=NOW() WHERE kennel_id=$1 AND ended_at IS NULL`, [req.kennelId]
  );
  await execute(
    `UPDATE exceptions SET status='resolved', resolved_at=NOW(), resolution_note='emergency ended'
      WHERE kennel_id=$1 AND kind='emergency' AND status IN ('open','escalated','snoozed')`,
    [req.kennelId]
  );
  res.json({ ok: true });
}),
);

// ══ Enrichment / play rotation ════════════════════════════════════════════
router.get(
  '/enrichment',
  apiRoute({
    method: 'get', path: '/api/breeder/ops/enrichment', tags: T, secure: true,
    summary: 'Enrichment sessions for a day (default today).',
    request: { query: z.object({ date: z.string().optional() }) },
    responses: { 200: { description: 'ok', schema: z.object({ sessions: z.array(z.record(z.string(), z.unknown())) }) } },
  }),
  ah(async (req, res) => {
  const day = String(req.query.date ?? new Date().toISOString().slice(0, 10));
  const rows = await query(
    `SELECT e.*, a.name AS animal_name FROM enrichment_sessions e
       LEFT JOIN animals a ON a.id = e.animal_id
      WHERE e.kennel_id=$1 AND e.scheduled_start::date = $2
      ORDER BY e.scheduled_start, e.station`,
    [req.kennelId, day]
  );
  res.json({ sessions: rows });
}),
);

router.post(
  '/enrichment/generate',
  apiRoute({
    method: 'post', path: '/api/breeder/ops/enrichment/generate', tags: T, secure: true,
    summary: 'Generate an enrichment rotation for a day.',
    request: {
      body: z.object({
        stations: z.array(z.string()).min(1),
        animalIds: z.array(z.string()).optional(),
        date: z.string().optional(),
        dayStart: z.string().optional(),
        dayEnd: z.string().optional(),
        slotMinutes: z.coerce.number().optional(),
      }),
    },
    responses: { 201: { description: 'created' } },
  }),
  ah(async (req, res) => {
  const b = req.body;
  const animals = b.animalIds?.length
    ? b.animalIds
    : (await query<{ id: string }>(`SELECT id FROM animals WHERE kennel_id=$1 AND status='active'`, [req.kennelId])).map((r) => r.id);

  const date = b.date ? new Date(b.date) : new Date();
  const planned = generateRotation({
    animalIds: animals,
    stations: b.stations,
    date,
    dayStart: b.dayStart ?? '09:00',
    dayEnd: b.dayEnd ?? '17:00',
    slotMinutes: b.slotMinutes ?? 30,
  });
  for (const s of planned) {
    await execute(
      `INSERT INTO enrichment_sessions (kennel_id, animal_id, station, scheduled_start, scheduled_end)
       VALUES ($1,$2,$3,$4,$5)`,
      [req.kennelId, s.animalId, s.station, s.scheduledStart, s.scheduledEnd]
    );
  }
  res.status(201).json({ created: planned.length, planned });
}),
);

router.post(
  '/enrichment/:id/complete',
  apiRoute({
    method: 'post', path: '/api/breeder/ops/enrichment/{id}/complete', tags: T, secure: true,
    summary: 'Mark an enrichment session done.',
    request: {
      params: z.object({ id: z.string() }),
      body: z.object({ activityMinutes: z.coerce.number().nullable().optional() }),
    },
    responses: { 200: { description: 'ok' }, 404: { description: 'not found' } },
  }),
  ah(async (req, res) => {
  const row = await queryOne(
    `UPDATE enrichment_sessions SET status='done', activity_minutes=$3
      WHERE id=$1 AND kennel_id=$2 RETURNING *`,
    [req.params.id, req.kennelId, req.body?.activityMinutes ?? null]
  );
  if (!row) return bad(res, 'Session not found', 404);
  res.json({ session: row });
}),
);

// ══ Offline / power-cut journal ══════════════════════════════════════════
router.get(
  '/offline-journal',
  apiRoute({
    method: 'get', path: '/api/breeder/ops/offline-journal', tags: T, secure: true,
    summary: 'Recent offline / power-cut journal entries.',
    responses: { 200: { description: 'ok', schema: z.object({ journal: z.array(z.record(z.string(), z.unknown())) }) } },
  }),
  ah(async (req, res) => {
  const rows = await query(
    `SELECT j.*, d.name AS device_name FROM offline_journal j
       LEFT JOIN devices d ON d.device_id = j.device_id
      WHERE j.kennel_id=$1 ORDER BY j.went_offline_at DESC LIMIT 100`,
    [req.kennelId]
  );
  res.json({ journal: rows });
}),
);

/** Device reports, on reconnect, the window it was dark and what it did offline. */
router.post(
  '/offline-journal',
  apiRoute({
    method: 'post', path: '/api/breeder/ops/offline-journal', tags: T, secure: true,
    summary: 'Record an offline / power-cut window for a device.',
    request: {
      body: z.object({
        deviceId: z.string().min(1),
        wentOfflineAt: z.string().min(1),
        cameOnlineAt: z.string().nullable().optional(),
        cause: z.string().optional(),
        missedActions: z.array(z.record(z.string(), z.unknown())).optional(),
        backfilled: z.boolean().optional(),
      }),
    },
    responses: { 200: { description: 'ok' } },
  }),
  ah(async (req, res) => {
  const b = req.body;
  const row = await queryOne(
    `INSERT INTO offline_journal (kennel_id, device_id, went_offline_at, came_online_at, cause, missed_actions, backfilled)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.kennelId, b.deviceId, b.wentOfflineAt, b.cameOnlineAt ?? new Date(), b.cause ?? 'unknown',
     JSON.stringify(b.missedActions ?? []), b.backfilled ?? false]
  );
  // A power-cause gap during a litter is worth a human glance.
  if (b.cause === 'power') {
    await raiseException({
      kennelId: req.kennelId!, kind: 'power-cut', severity: 'warning', deviceId: b.deviceId,
      title: `Power cut recovered on ${b.deviceId}`,
      detail: `Offline ${b.wentOfflineAt} → ${b.cameOnlineAt ?? 'now'}`,
      suggestedAction: 'Confirm feeders/water caught up; check the litter',
      dedupKey: `power-cut:${b.deviceId}:${b.wentOfflineAt}`,
    });
  }
  res.json({ entry: row });
}),
);

// ══ Notification preferences ═════════════════════════════════════════════

/** Which channels this deployment can actually deliver on (env-configured). */
router.get(
  '/notification-channels',
  apiRoute({
    method: 'get', path: '/api/breeder/ops/notification-channels', tags: T, secure: true,
    summary: 'Which notification channels this deployment can deliver on.',
    responses: { 200: { description: 'ok' } },
  }),
  ah(async (_req, res) => {
  const list = ['log', 'webhook', 'email', 'sms', 'siren', 'push'];
  res.json({ channels: Object.fromEntries(list.map((c) => [c, channelConfigured(c)])) });
}),
);

router.get(
  '/notification-prefs',
  apiRoute({
    method: 'get', path: '/api/breeder/ops/notification-prefs', tags: T, secure: true,
    summary: 'The current user’s notification preferences.',
    responses: { 200: { description: 'ok' } },
  }),
  ah(async (req, res) => {
  const row = await queryOne(`SELECT * FROM notification_prefs WHERE user_id=$1`, [req.user?.id]);
  res.json({ prefs: row ?? null });
}),
);

router.put(
  '/notification-prefs',
  apiRoute({
    method: 'put', path: '/api/breeder/ops/notification-prefs', tags: T, secure: true,
    summary: 'Upsert the current user’s notification preferences.',
    request: {
      body: z.object({
        channels: z.array(z.string()).optional(),
        quietHours: z.record(z.string(), z.unknown()).nullable().optional(),
        escalation: z.array(z.record(z.string(), z.unknown())).optional(),
        webhookUrl: z.string().nullable().optional(),
        smsNumber: z.string().nullable().optional(),
        email: z.string().nullable().optional(),
      }),
    },
    responses: { 200: { description: 'ok' } },
  }),
  ah(async (req, res) => {
  const b = req.body;
  const row = await queryOne(
    `INSERT INTO notification_prefs (user_id, kennel_id, channels, quiet_hours, escalation, webhook_url, sms_number, email)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (user_id) DO UPDATE SET
       kennel_id=EXCLUDED.kennel_id, channels=EXCLUDED.channels, quiet_hours=EXCLUDED.quiet_hours,
       escalation=EXCLUDED.escalation, webhook_url=EXCLUDED.webhook_url, sms_number=EXCLUDED.sms_number,
       email=EXCLUDED.email, updated_at=NOW()
     RETURNING *`,
    [req.user?.id, req.kennelId, JSON.stringify(b.channels ?? ['log']),
     b.quietHours ? JSON.stringify(b.quietHours) : null, JSON.stringify(b.escalation ?? []),
     b.webhookUrl ?? null, b.smsNumber ?? null, b.email ?? null]
  );
  res.json({ prefs: row });
}),
);

export default router;
