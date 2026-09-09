/**
 * Care-inbox exceptions: create (with dedup), triage transitions, and the
 * notification fan-out that goes with a new exception.
 *
 * Shared by HTTP routes and the rules/maintenance engines.
 */
import { query, queryOne, execute } from '../database/index.js';
import { exceptionPriority, channelsForDelivery, type Severity } from './logic/delivery.js';
import { emitStream } from './stream.js';

export interface RaiseExceptionInput {
  kennelId: string;
  kind: string;
  severity?: Severity;
  title: string;
  detail?: string;
  deviceId?: string | null;
  animalId?: string | null;
  penId?: string | null;
  ruleId?: string | null;
  suggestedAction?: string | null;
  dedupKey?: string | null;
  priority?: number;
  notifyAudience?: 'on-call' | 'manager' | 'all' | null;
}

export interface ExceptionRow {
  id: string;
  kennel_id: string;
  kind: string;
  severity: string;
  priority: number;
  title: string;
  status: string;
  created_at: string;
  [k: string]: unknown;
}

/**
 * Create an exception, or bump the existing open one with the same dedup_key.
 * Returns { exception, created }.
 */
export async function raiseException(input: RaiseExceptionInput): Promise<{ exception: ExceptionRow; created: boolean }> {
  const severity: Severity = input.severity ?? 'warning';
  const dedupKey = input.dedupKey ?? `${input.kind}:${input.deviceId ?? input.animalId ?? input.penId ?? 'kennel'}`;

  const existing = await queryOne<ExceptionRow>(
    `SELECT * FROM exceptions
      WHERE kennel_id = $1 AND dedup_key = $2 AND status IN ('open','snoozed','escalated')
      ORDER BY created_at DESC LIMIT 1`,
    [input.kennelId, dedupKey]
  );

  if (existing) {
    await execute(
      `UPDATE exceptions
          SET detail = COALESCE($2, detail),
              severity = $3,
              priority = GREATEST(priority, $4),
              updated_at = NOW()
        WHERE id = $1`,
      [existing.id, input.detail ?? null, severity, input.priority ?? existing.priority]
    );
    const bumped = await queryOne<ExceptionRow>('SELECT * FROM exceptions WHERE id = $1', [existing.id]);
    emitStream(input.kennelId, { type: 'exception', action: 'updated', exception: (bumped ?? existing) as Record<string, unknown> });
    return { exception: bumped ?? existing, created: false };
  }

  const priority = input.priority ?? exceptionPriority({ severity, kind: input.kind, ageSeconds: 0 });
  const row = await queryOne<ExceptionRow>(
    `INSERT INTO exceptions
       (kennel_id, kind, severity, priority, title, detail, device_id, animal_id, pen_id, rule_id,
        suggested_action, dedup_key, first_notified_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW())
     RETURNING *`,
    [
      input.kennelId, input.kind, severity, priority, input.title, input.detail ?? null,
      input.deviceId ?? null, input.animalId ?? null, input.penId ?? null, input.ruleId ?? null,
      input.suggestedAction ?? null, dedupKey,
    ]
  );
  const exception = row as ExceptionRow;

  await enqueueNotifications(exception, input.notifyAudience ?? null);
  emitStream(input.kennelId, { type: 'exception', action: 'created', exception: exception as Record<string, unknown> });
  return { exception, created: true };
}

/** Queue an initial notification per recipient, honouring quiet hours. */
export async function enqueueNotifications(
  exception: ExceptionRow,
  audience: 'on-call' | 'manager' | 'all' | null
): Promise<void> {
  const recipients = await query<{
    user_id: string; channels: string[] | null; quiet_hours: any; webhook_url: string | null;
    sms_number: string | null; email: string | null;
  }>(
    `SELECT np.user_id, np.channels, np.quiet_hours, np.webhook_url, np.sms_number, np.email
       FROM notification_prefs np
       JOIN users u ON u.id = np.user_id
      WHERE (np.kennel_id = $1 OR u.kennel_id = $1)`,
    [exception.kennel_id]
  );

  const now = new Date();
  const rowsToInsert: Array<[string, string, string, string, string, string, string]> = [];

  const list = recipients.length
    ? recipients
    : [{ user_id: null as any, channels: ['log'], quiet_hours: null, webhook_url: null, sms_number: null, email: null }];

  for (const r of list) {
    const configured = Array.isArray(r.channels) && r.channels.length ? r.channels : ['log'];
    const { channels } = channelsForDelivery({
      configuredChannels: configured,
      severity: exception.severity as Severity,
      quietHours: r.quiet_hours ?? null,
      now,
    });
    for (const channel of channels) {
      const target =
        channel === 'webhook' ? r.webhook_url ?? ''
        : channel === 'sms' ? r.sms_number ?? ''
        : channel === 'email' ? r.email ?? ''
        : '';
      rowsToInsert.push([
        exception.kennel_id, exception.id, r.user_id, channel, target,
        `[${exception.severity}] ${exception.title}`,
        `${exception.title}${exception.detail ? ' — ' + exception.detail : ''} (audience: ${audience ?? 'default'})`,
      ]);
    }
  }

  for (const vals of rowsToInsert) {
    await execute(
      `INSERT INTO notifications (kennel_id, exception_id, user_id, channel, target, subject, body)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      vals
    );
  }
}

export type Transition = 'acknowledge' | 'snooze' | 'resolve' | 'escalate' | 'assign' | 'reopen';

export async function transitionException(
  id: string,
  kennelId: string,
  action: Transition,
  opts: { userId?: string | null; note?: string; snoozeMinutes?: number; assignTo?: string | null } = {}
): Promise<ExceptionRow | null> {
  const ex = await queryOne<ExceptionRow>('SELECT * FROM exceptions WHERE id = $1 AND kennel_id = $2', [id, kennelId]);
  if (!ex) return null;

  switch (action) {
    case 'acknowledge':
      await execute(
        `UPDATE exceptions SET status='acknowledged', acknowledged_at=NOW(), acknowledged_by=$2, updated_at=NOW() WHERE id=$1`,
        [id, opts.userId ?? null]
      );
      break;
    case 'snooze': {
      const until = new Date(Date.now() + (opts.snoozeMinutes ?? 60) * 60_000);
      await execute(
        `UPDATE exceptions SET status='snoozed', snoozed_until=$2, updated_at=NOW() WHERE id=$1`,
        [id, until]
      );
      break;
    }
    case 'resolve':
      await execute(
        `UPDATE exceptions SET status='resolved', resolved_at=NOW(), resolved_by=$2, resolution_note=$3, updated_at=NOW() WHERE id=$1`,
        [id, opts.userId ?? null, opts.note ?? null]
      );
      break;
    case 'escalate':
      await execute(
        `UPDATE exceptions SET status='escalated', escalation_step=escalation_step+1, updated_at=NOW() WHERE id=$1`,
        [id]
      );
      break;
    case 'assign':
      await execute(`UPDATE exceptions SET assigned_to=$2, updated_at=NOW() WHERE id=$1`, [id, opts.assignTo ?? null]);
      break;
    case 'reopen':
      await execute(
        `UPDATE exceptions SET status='open', acknowledged_at=NULL, resolved_at=NULL, snoozed_until=NULL, updated_at=NOW() WHERE id=$1`,
        [id]
      );
      break;
  }
  const updated = await queryOne<ExceptionRow>('SELECT * FROM exceptions WHERE id = $1', [id]);
  if (updated) emitStream(kennelId, { type: 'exception', action: 'updated', exception: updated as Record<string, unknown> });
  return updated;
}
