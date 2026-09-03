/**
 * Runtime config. JWT_SECRET has no hardcoded fallback — boot fails if unset.
 */
export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is required');
  }
  return secret;
}

export function assertJwtSecretOrExit(): void {
  try {
    getJwtSecret();
  } catch {
    console.error('Fatal: JWT_SECRET is unset. Refusing to boot.');
    process.exit(1);
  }
}

export const PORT = parseInt(process.env.PORT || '3000', 10);
export const FOOD_LOW_THRESHOLD = 20;
export const FEED_ACK_TIMEOUT_MS = parseInt(process.env.FEED_ACK_TIMEOUT_MS || '8000', 10);
