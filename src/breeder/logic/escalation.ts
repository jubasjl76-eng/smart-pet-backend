/**
 * Notification escalation chains.
 *
 * A chain is an ordered list of steps. Each step fires once, `afterSeconds` after
 * the exception was first notified, UNLESS the exception has been acknowledged or
 * resolved by then. Step 0 (the initial notify) is implicit and always sent.
 */

export interface EscalationStep {
  afterSeconds: number;
  userId?: string | null;
  channel: 'log' | 'webhook' | 'sms' | 'email' | 'push' | 'siren';
  target?: string | null;
  label?: string;
}

export type ExceptionStatusForEscalation =
  | 'open'
  | 'acknowledged'
  | 'snoozed'
  | 'resolved'
  | 'escalated';

export interface EscalationInput {
  chain: EscalationStep[];
  firstNotifiedAt: Date | string | number;
  now: Date;
  status: ExceptionStatusForEscalation;
  /** Highest step index already delivered (from exceptions.escalation_step). */
  lastDeliveredStep: number;
  /** A snoozed exception resumes escalating after this time. */
  snoozedUntil?: Date | string | number | null;
}

function toMs(v: Date | string | number): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  return Date.parse(v);
}

/**
 * Returns the steps that are due to be delivered now (may be more than one if the
 * process was down). Empty when acknowledged/resolved, still snoozed, or nothing due.
 */
export function dueEscalationSteps(input: EscalationInput): Array<{ index: number; step: EscalationStep }> {
  const { chain, status, now, lastDeliveredStep } = input;
  if (status === 'acknowledged' || status === 'resolved') return [];
  if (input.snoozedUntil && toMs(input.snoozedUntil) > now.getTime()) return [];

  const base = toMs(input.firstNotifiedAt);
  if (Number.isNaN(base)) return [];
  const elapsed = (now.getTime() - base) / 1000;

  const due: Array<{ index: number; step: EscalationStep }> = [];
  chain.forEach((step, index) => {
    const humanIndex = index + 1; // step 0 is the implicit initial notify
    if (humanIndex <= lastDeliveredStep) return;
    if (elapsed >= step.afterSeconds) due.push({ index: humanIndex, step });
  });
  return due;
}

/** Convenience: the single next step index that would come after `lastDeliveredStep`. */
export function nextStepIndex(chain: EscalationStep[], lastDeliveredStep: number): number | null {
  const next = lastDeliveredStep + 1;
  return next <= chain.length ? next : null;
}
