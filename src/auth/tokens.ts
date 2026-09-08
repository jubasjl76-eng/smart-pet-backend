/**
 * Rotating refresh tokens.
 *
 * The client holds an opaque random string; we store only its SHA-256. On
 * refresh we revoke the presented token and issue a new one in the same
 * `family`. If a token that was already replaced is presented again (reuse), the
 * whole family is revoked — that's the theft-detection signal.
 */
import crypto from 'crypto';
import { query, queryOne, execute } from '../database/index.js';

const REFRESH_TTL_DAYS = parseInt(process.env.REFRESH_TTL_DAYS || '30', 10);

export function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function newOpaque(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export interface IssuedRefresh {
  token: string;      // give this to the client
  expiresAt: Date;
  family: string;
}

export async function issueRefreshToken(
  userId: string,
  userAgent?: string,
  family?: string
): Promise<IssuedRefresh> {
  const token = newOpaque();
  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 86_400_000);
  const row = await queryOne<{ family: string }>(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, family)
     VALUES ($1, $2, $3, $4, COALESCE($5::uuid, gen_random_uuid()))
     RETURNING family`,
    [userId, sha256(token), expiresAt, (userAgent ?? '').slice(0, 255) || null, family ?? null]
  );
  return { token, expiresAt, family: row!.family };
}

export interface RotateResult {
  userId: string;
  refresh: IssuedRefresh;
}

/** Verify + rotate. Returns null on any failure (expired / revoked / unknown). */
export async function rotateRefreshToken(rawToken: string, userAgent?: string): Promise<RotateResult | null> {
  const hash = sha256(rawToken);
  const rec = await queryOne<{
    id: string; user_id: string; family: string; revoked_at: string | null;
    replaced_by: string | null; expires_at: string;
  }>(`SELECT id, user_id, family, revoked_at, replaced_by, expires_at FROM refresh_tokens WHERE token_hash = $1`, [hash]);

  if (!rec) return null;
  if (new Date(rec.expires_at).getTime() < Date.now()) return null;

  if (rec.revoked_at || rec.replaced_by) {
    // Reuse of a spent token → revoke the whole family.
    await execute(
      `UPDATE refresh_tokens SET revoked_at = NOW() WHERE family = $1 AND revoked_at IS NULL`,
      [rec.family]
    );
    return null;
  }

  const next = await issueRefreshToken(rec.user_id, userAgent, rec.family);
  const nextRec = await queryOne<{ id: string }>(
    `SELECT id FROM refresh_tokens WHERE token_hash = $1`, [sha256(next.token)]
  );
  await execute(
    `UPDATE refresh_tokens SET revoked_at = NOW(), replaced_by = $2 WHERE id = $1`,
    [rec.id, nextRec!.id]
  );
  return { userId: rec.user_id, refresh: next };
}

export async function revokeRefreshToken(rawToken: string): Promise<void> {
  await execute(
    `UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL`,
    [sha256(rawToken)]
  );
}

export async function revokeAllForUser(userId: string): Promise<void> {
  await execute(
    `UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
}

/** Housekeeping — drop rows that expired or were revoked more than a week ago. */
export async function pruneRefreshTokens(): Promise<number> {
  const rows = await query<{ id: string }>(
    `DELETE FROM refresh_tokens
      WHERE expires_at < NOW() - INTERVAL '7 days'
         OR revoked_at < NOW() - INTERVAL '7 days'
     RETURNING id`
  );
  return rows.length;
}
