/**
 * Staff / owner invites. An owner creates an invite for an email + role; the
 * invitee accepts it with a name + password, which creates their account bound
 * to the same kennel. Email delivery of the link is Phase 3 — until then the
 * token is returned to the creator.
 */
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { query, queryOne, execute } from '../database/index.js';
import { mapRole } from '../identity/roles.js';

const INVITE_TTL_DAYS = parseInt(process.env.INVITE_TTL_DAYS || '7', 10);

export function inviteToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

export interface CreateInviteInput {
  email: string;
  role: 'owner' | 'staff';
  kennelId: string;
  invitedBy: string | null;
}

export async function createInvite(input: CreateInviteInput): Promise<{ token: string; expiresAt: Date; role: string }> {
  const email = input.email.trim().toLowerCase();
  const existingUser = await queryOne<{ id: string }>('SELECT id FROM users WHERE lower(email) = $1', [email]);
  if (existingUser) throw new Error('A user with that email already exists');

  const role = mapRole(input.role);
  const token = inviteToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000);

  // supersede any open invite for the same email in this kennel
  await execute(
    `UPDATE user_invites SET accepted_at = NOW() WHERE lower(email) = $1 AND kennel_id = $2 AND accepted_at IS NULL`,
    [email, input.kennelId]
  );
  await execute(
    `INSERT INTO user_invites (token, email, role, kennel_id, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [token, email, role, input.kennelId, input.invitedBy, expiresAt]
  );
  return { token, expiresAt, role };
}

export interface AcceptInviteResult {
  user: { id: string; email: string; name: string | null; role: string; kennel_id: string; active: boolean };
}

export async function acceptInvite(token: string, name: string, password: string): Promise<AcceptInviteResult> {
  const inv = await queryOne<{
    email: string; role: string; kennel_id: string; expires_at: string; accepted_at: string | null;
  }>(`SELECT email, role, kennel_id, expires_at, accepted_at FROM user_invites WHERE token = $1`, [token]);

  if (!inv || inv.accepted_at) throw new Error('Invite is invalid or already used');
  if (new Date(inv.expires_at).getTime() < Date.now()) throw new Error('Invite has expired');
  if (String(password || '').length < 6) throw new Error('Password must be at least 6 characters');

  const existing = await queryOne<{ id: string }>('SELECT id FROM users WHERE lower(email) = $1', [inv.email]);
  if (existing) throw new Error('A user with that email already exists');

  const hash = await bcrypt.hash(password, 10);
  await execute(
    `INSERT INTO users (email, password_hash, name, role, kennel_id, active)
     VALUES ($1, $2, $3, $4, $5, true)`,
    [inv.email, hash, name?.trim() || null, mapRole(inv.role), inv.kennel_id]
  );
  const user = await queryOne<any>(
    `SELECT id, email, name, role, kennel_id, active FROM users WHERE lower(email) = $1`,
    [inv.email]
  );
  await execute(
    `UPDATE user_invites SET accepted_at = NOW(), accepted_user_id = $2 WHERE token = $1`,
    [token, user.id]
  );
  return { user };
}

export async function listInvites(kennelId: string): Promise<unknown[]> {
  return query(
    `SELECT token, email, role, invited_by, expires_at, accepted_at, created_at
       FROM user_invites WHERE kennel_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [kennelId]
  );
}

export async function revokeInvite(token: string, kennelId: string): Promise<boolean> {
  const rows = await query<{ token: string }>(
    `UPDATE user_invites SET accepted_at = NOW()
      WHERE token = $1 AND kennel_id = $2 AND accepted_at IS NULL RETURNING token`,
    [token, kennelId]
  );
  return rows.length > 0;
}
