/**
 * Notification channel adapters + retry planning.
 *
 * Real: log, webhook (in notifier.ts), email (Resend), SMS (Twilio), siren (MQTT).
 * All provider adapters are env-gated — no key → `suppressed` with a clear reason,
 * never a hard failure.
 */
import { circuitBreaker } from '../../circuitBreaker.js';

export type ChannelResult = {
  status: 'sent' | 'failed' | 'suppressed';
  error?: string;
  ref?: string;
};

/** Which channels this deployment can actually deliver on right now. */
export function channelConfigured(channel: string): boolean {
  switch (channel) {
    case 'log':
    case 'webhook': // per-recipient target, always "available"
    case 'siren': // via MQTT; broker reachability is checked at send time
      return true;
    case 'email':
      return !!(process.env.RESEND_API_KEY && process.env.NOTIFY_EMAIL_FROM);
    case 'sms':
      return !!(
        process.env.TWILIO_ACCOUNT_SID &&
        process.env.TWILIO_AUTH_TOKEN &&
        process.env.TWILIO_FROM
      );
    default:
      return false; // push, unknown
  }
}

const resendBreaker = circuitBreaker(
  'resend',
  async (key: string, from: string, to: string, subject: string, body: string) => {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to, subject, text: body }),
    });
    if (!r.ok) throw new Error(`resend HTTP ${r.status}`);
    return (await r.json().catch(() => ({}))) as { id?: string };
  },
);

export async function sendEmail(to: string, subject: string, body: string): Promise<ChannelResult> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.NOTIFY_EMAIL_FROM;
  if (!key || !from) {
    return {
      status: 'suppressed',
      error: 'email not configured (RESEND_API_KEY / NOTIFY_EMAIL_FROM)',
    };
  }
  if (!to) return { status: 'suppressed', error: 'recipient has no email address' };
  try {
    const data = await resendBreaker.fire(key, from, to, subject, body);
    return { status: 'sent', ref: data.id };
  } catch (e) {
    return { status: 'failed', error: (e as Error).message };
  }
}

const twilioBreaker = circuitBreaker(
  'twilio',
  async (sid: string, token: string, from: string, to: string, body: string) => {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: from, Body: body.slice(0, 1500) }).toString(),
    });
    if (!r.ok) throw new Error(`twilio HTTP ${r.status}`);
    return (await r.json().catch(() => ({}))) as { sid?: string };
  },
);

export async function sendSms(to: string, body: string): Promise<ChannelResult> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  if (!sid || !token || !from) {
    return {
      status: 'suppressed',
      error: 'sms not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM)',
    };
  }
  if (!to) return { status: 'suppressed', error: 'recipient has no phone number' };
  try {
    const data = await twilioBreaker.fire(sid, token, from, to, body);
    return { status: 'sent', ref: data.sid };
  } catch (e) {
    return { status: 'failed', error: (e as Error).message };
  }
}

/** Exponential backoff: attempt 1 → 60s, 2 → 300s, 3 → 1500s, … capped at 6h. */
export function backoffSeconds(attempts: number): number {
  const n = Math.max(1, attempts);
  return Math.min(60 * 5 ** (n - 1), 6 * 3600);
}

/** What to write back after a delivery attempt. */
export function planNextAttempt(
  result: ChannelResult,
  attempts: number,
  maxAttempts: number,
  now: number = Date.now(),
): { status: 'sent' | 'failed' | 'suppressed' | 'queued'; nextAttemptAt: Date | null } {
  if (result.status === 'sent' || result.status === 'suppressed') {
    return { status: result.status, nextAttemptAt: null };
  }
  if (attempts >= maxAttempts) return { status: 'failed', nextAttemptAt: null };
  return { status: 'queued', nextAttemptAt: new Date(now + backoffSeconds(attempts) * 1000) };
}
