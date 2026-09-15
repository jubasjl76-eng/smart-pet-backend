import { circuitBreaker } from '../circuitBreaker.js';

// Trips after repeated failures so a dead/slow revalidate endpoint stops
// eating a fetch + timeout on every website write (Phase 20, A12 #5).
const revalidateBreaker = circuitBreaker(
  'revalidate-webhook',
  async (url: string, secret: string) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret }),
    });
    if (!r.ok) throw new Error(`revalidate HTTP ${r.status}`);
  },
);

/**
 * Fire-and-forget ping to the marketing site so it refreshes before its ISR
 * window elapses. No-op unless both env vars are set. Never throws.
 */
export function fireRevalidate(): void {
  const url = process.env.WEBSITE_REVALIDATE_URL;
  const secret = process.env.WEBSITE_REVALIDATE_SECRET;
  if (!url || !secret) return;

  revalidateBreaker.fire(url, secret).catch((e) => {
    console.warn('[website] revalidate ping failed:', (e as Error).message);
  });
}
