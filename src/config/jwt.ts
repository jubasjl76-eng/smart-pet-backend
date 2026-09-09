/** Fail boot / token ops if JWT_SECRET is unset. No hardcoded fallback. */
export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || !secret.trim()) {
    throw new Error('JWT_SECRET is required');
  }
  return secret;
}

export function assertJwtSecretOrExit(): void {
  try {
    getJwtSecret();
  } catch (err) {
    console.error('[boot] JWT_SECRET is unset. Refusing to start.');
    process.exit(1);
  }
}
