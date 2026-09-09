/**
 * Fire-and-forget ping to the marketing site so it refreshes before its ISR
 * window elapses. No-op unless both env vars are set. Never throws.
 */
export function fireRevalidate(): void {
  const url = process.env.WEBSITE_REVALIDATE_URL;
  const secret = process.env.WEBSITE_REVALIDATE_SECRET;
  if (!url || !secret) return;

  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret }),
  }).catch((e) => {
    console.warn('[website] revalidate ping failed:', (e as Error).message);
  });
}
