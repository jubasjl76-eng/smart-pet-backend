/** Buyer-communication helpers — pure. */

export function nextWeeklyRun(from: Date = new Date()): Date {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + 7);
  return d;
}

/** Swap {name} in a broadcast body for the buyer's name (first word). */
export function personalize(body: string, buyerName?: string | null): string {
  const first = (buyerName ?? '').trim().split(/\s+/)[0] || 'there';
  return body.replace(/\{name\}/g, first);
}

export interface UpdatePackData {
  puppyName: string;
  buyerName?: string | null;
  latestGrams?: number | null;
  gainPerDay?: number | null;
  weeksOld?: number | null;
  photos: string[];
  goHomeOn?: string | null;
}

export function renderUpdatePack(d: UpdatePackData): { subject: string; body: string } {
  const subject = `${d.puppyName}: this week's update`;
  const lines = [
    `Hi ${(d.buyerName ?? '').trim().split(/\s+/)[0] || 'there'},`,
    '',
    `Here is this week's update on ${d.puppyName}.`,
  ];
  if (d.weeksOld != null) {
    lines.push(`Age: ${d.weeksOld} week${d.weeksOld === 1 ? '' : 's'}.`);
  }
  if (d.latestGrams != null) {
    lines.push(
      `Weight: ${d.latestGrams} g${
        d.gainPerDay != null ? ` (about +${Math.round(d.gainPerDay)} g a day)` : ''
      }.`,
    );
  }
  if (d.photos.length) {
    lines.push('', 'Photos:', ...d.photos);
  }
  if (d.goHomeOn) {
    lines.push('', `Go-home date: ${d.goHomeOn}.`);
  }
  lines.push('', 'More soon.');
  return { subject, body: lines.join('\n') };
}
