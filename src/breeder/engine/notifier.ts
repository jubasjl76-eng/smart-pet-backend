/**
 * Notification worker: delivers queued notifications and runs escalation chains.
 *
 * Channel adapters:
 *   - log      → console (always available)
 *   - webhook  → HTTP POST to the user's webhook_url (real)
 *   - sms/email/push/siren → adapter stubs. Marked 'suppressed' with a clear
 *     reason until a provider is wired in (Twilio, SES, FCM, a relay board).
 */
import { query, queryOne, execute } from '../../database/index.js';
import { dueEscalationSteps, type EscalationStep } from '../logic/escalation.js';

async function deliver(n: {
  id: string; channel: string; target: string | null; subject: string | null; body: string | null;
}): Promise<{ status: 'sent' | 'failed' | 'suppressed'; error?: string }> {
  switch (n.channel) {
    case 'log':
      console.log(`[notify] ${n.subject ?? ''} :: ${n.body ?? ''}`);
      return { status: 'sent' };
    case 'webhook': {
      if (!n.target) return { status: 'suppressed', error: 'no webhook_url configured' };
      try {
        const r = await fetch(n.target, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ subject: n.subject, body: n.body, at: new Date().toISOString() }),
        });
        return r.ok ? { status: 'sent' } : { status: 'failed', error: `HTTP ${r.status}` };
      } catch (e) {
        return { status: 'failed', error: (e as Error).message };
      }
    }
    case 'sms':
    case 'email':
    case 'push':
    case 'siren':
      return { status: 'suppressed', error: `${n.channel} adapter not configured` };
    default:
      return { status: 'failed', error: `unknown channel ${n.channel}` };
  }
}

export async function drainNotifications(limit = 50): Promise<{ processed: number }> {
  const queued = await query<any>(
    `SELECT id, channel, target, subject, body FROM notifications
      WHERE status='queued' ORDER BY created_at LIMIT $1`,
    [limit]
  );
  for (const n of queued) {
    const result = await deliver(n);
    await execute(
      `UPDATE notifications SET status=$2, attempts=attempts+1, error=$3,
             sent_at = CASE WHEN $2='sent' THEN NOW() ELSE sent_at END
       WHERE id=$1`,
      [n.id, result.status, result.error ?? null]
    );
  }
  return { processed: queued.length };
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
          `Unhandled ${ex.severity} for too long: ${ex.title}${ex.detail ? ' — ' + ex.detail : ''}`,
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
