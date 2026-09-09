/**
 * Notification worker: delivers queued notifications and runs escalation chains.
 *
 * Channel adapters:
 *   - log      → console (always available)
 *   - webhook  → HTTP POST to the step's target URL
 *   - email    → Resend (env-gated)
 *   - sms      → Twilio (env-gated)
 *   - siren    → MQTT `relay` command to the step's target device
 *   - push     → not wired; 'suppressed'
 * A failed attempt is retried with exponential backoff up to `max_attempts`.
 */
import { query, execute } from '../../database/index.js';
import { dueEscalationSteps, type EscalationStep } from '../logic/escalation.js';
import { publishCommand } from '../../services/feederMqtt.js';
import { sendEmail, sendSms, planNextAttempt, type ChannelResult } from './channels.js';

type QueuedNotification = {
  id: string;
  kennel_id: string;
  channel: string;
  target: string | null;
  subject: string | null;
  body: string | null;
  attempts: number | null;
  max_attempts: number | null;
};

async function deliver(n: QueuedNotification): Promise<ChannelResult> {
  const subject = n.subject ?? 'Smart Pet alert';
  const body = n.body ?? '';
  switch (n.channel) {
    case 'log':
      console.log(`[notify] ${subject} :: ${body}`);
      return { status: 'sent' };
    case 'webhook': {
      if (!n.target) return { status: 'suppressed', error: 'no webhook_url on the recipient' };
      try {
        const r = await fetch(n.target, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ subject, body, at: new Date().toISOString() }),
        });
        return r.ok ? { status: 'sent' } : { status: 'failed', error: `HTTP ${r.status}` };
      } catch (e) {
        return { status: 'failed', error: (e as Error).message };
      }
    }
    case 'email':
      return sendEmail(n.target ?? '', subject, body);
    case 'sms':
      return sendSms(n.target ?? '', `${subject}: ${body}`);
    case 'siren': {
      if (!n.target) return { status: 'suppressed', error: 'no siren device on the step' };
      try {
        await publishCommand(n.kennel_id, n.target, {
          command: 'relay',
          params: { action: 'pulse', ms: 5000, reason: 'alert' },
          deviceId: n.target,
          kennelId: n.kennel_id,
          timestamp: Date.now(),
        });
        return { status: 'sent' };
      } catch (e) {
        return { status: 'failed', error: (e as Error).message };
      }
    }
    case 'push':
      return { status: 'suppressed', error: 'push adapter not configured' };
    default:
      return { status: 'failed', error: `unknown channel ${n.channel}` };
  }
}

export async function drainNotifications(
  limit = 50,
): Promise<{ processed: number; sent: number; retrying: number; failed: number }> {
  const queued = await query<QueuedNotification>(
    `SELECT id, kennel_id, channel, target, subject, body, attempts, max_attempts
       FROM notifications
      WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
      ORDER BY created_at LIMIT $1`,
    [limit],
  );

  let sent = 0;
  let retrying = 0;
  let failed = 0;

  for (const n of queued) {
    const result = await deliver(n);
    const attempts = (n.attempts ?? 0) + 1;
    const plan = planNextAttempt(result, attempts, n.max_attempts ?? 5);

    await execute(
      `UPDATE notifications
          SET status = $2::text, attempts = $3::int, error = $4::text,
              provider_ref = COALESCE($5::text, provider_ref),
              next_attempt_at = $6::timestamptz,
              sent_at = CASE WHEN $2::text = 'sent' THEN NOW() ELSE sent_at END
        WHERE id = $1`,
      [n.id, plan.status, attempts, result.error ?? null, result.ref ?? null, plan.nextAttemptAt],
    );

    if (plan.status === 'sent') sent++;
    else if (plan.status === 'queued') retrying++;
    else if (plan.status === 'failed') failed++;
  }

  return { processed: queued.length, sent, retrying, failed };
}

export async function runEscalations(): Promise<{ escalated: number }> {
  const rows = await query<any>(
    `SELECT e.id, e.kennel_id, e.status, e.escalation_step, e.first_notified_at, e.snoozed_until,
            e.severity, e.title, e.detail
       FROM exceptions e
      WHERE e.status IN ('open','escalated','snoozed')
        AND e.first_notified_at IS NOT NULL`
  );
  let escalated = 0;

  for (const ex of rows) {
    // Union of every recipient's escalation chain for this kennel.
    const prefs = await query<{ escalation: EscalationStep[] | null; user_id: string }>(
      `SELECT np.escalation, np.user_id FROM notification_prefs np
         JOIN users u ON u.id = np.user_id
        WHERE (np.kennel_id = $1 OR u.kennel_id = $1)`,
      [ex.kennel_id]
    );
    const chain: EscalationStep[] = prefs
      .flatMap((p) => (Array.isArray(p.escalation) ? p.escalation : []))
      .sort((a, b) => a.afterSeconds - b.afterSeconds);
    if (chain.length === 0) continue;

    const due = dueEscalationSteps({
      chain,
      firstNotifiedAt: ex.first_notified_at,
      now: new Date(),
      status: ex.status,
      lastDeliveredStep: ex.escalation_step ?? 0,
      snoozedUntil: ex.snoozed_until,
    });
    if (due.length === 0) continue;

    for (const { step } of due) {
      await execute(
        `INSERT INTO notifications (kennel_id, exception_id, channel, target, subject, body)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          ex.kennel_id, ex.id, step.channel, step.target ?? null,
          `[escalation] ${ex.title}`,
          `Unhandled ${ex.severity} for too long: ${ex.title}${ex.detail ? '. ' + ex.detail : ''}`,
        ]
      );
    }
    const highest = due[due.length - 1].index;
    await execute(
      `UPDATE exceptions SET escalation_step=$2, status='escalated', updated_at=NOW() WHERE id=$1`,
      [ex.id, highest]
    );
    escalated++;
  }
  return { escalated };
}

export async function notifierTick(): Promise<void> {
  await runEscalations();
  await drainNotifications();
}
