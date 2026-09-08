/**
 * User administration for the kennel (owner-only), plus invites.
 *
 *   GET    /api/users               list users in the kennel
 *   POST   /api/users/invite        { email, role }  → invite token (email is Phase 3)
 *   GET    /api/users/invites       open + recent invites
 *   DELETE /api/users/invites/:token
 *   PATCH  /api/users/:id           { role?, active? }
 *
 * Accepting an invite is POST /api/auth/accept-invite (no auth).
 */
import { Router, type Response } from 'express';
import { query, queryOne, execute } from '../database/index.js';
import { auth, ownerOnly, type AuthRequest } from '../middleware/auth.js';
import { createInvite, listInvites, revokeInvite } from '../auth/invites.js';
import { revokeAllForUser } from '../auth/tokens.js';

const router = Router();
router.use(auth, ownerOnly);

async function callerKennel(req: AuthRequest): Promise<string> {
  const row = await queryOne<{ kennel_id: string | null }>('SELECT kennel_id FROM users WHERE id = $1', [req.user!.id]);
  return row?.kennel_id ?? process.env.BREEDER_KENNEL_SLUG ?? 'home';
}

router.get('/', async (req: AuthRequest, res: Response) => {
  const kennelId = await callerKennel(req);
  const users = await query(
    `SELECT id, email, name, role, active, created_at FROM users WHERE kennel_id = $1 ORDER BY created_at`,
    [kennelId]
  );
  res.json({ users });
});

router.post('/invite', async (req: AuthRequest, res: Response) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const role = req.body?.role === 'owner' ? 'owner' : 'staff';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    res.status(400).json({ error: 'A valid email is required' });
    return;
  }
  try {
    const kennelId = await callerKennel(req);
    const inv = await createInvite({ email, role, kennelId, invitedBy: req.user!.id });
    const base = process.env.APP_BASE_URL || 'http://localhost:5173';
    res.status(201).json({
      invite: {
        email, role: inv.role, token: inv.token, expiresAt: inv.expiresAt,
        acceptUrl: `${base}/accept-invite?token=${inv.token}`,
        note: 'Email delivery lands in Phase 3 — send this link manually for now.',
      },
    });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

router.get('/invites', async (req: AuthRequest, res: Response) => {
  res.json({ invites: await listInvites(await callerKennel(req)) });
});

router.delete('/invites/:token', async (req: AuthRequest, res: Response) => {
  const ok = await revokeInvite(String(req.params.token), await callerKennel(req));
  res.status(ok ? 200 : 404).json({ ok });
});

router.patch('/:id', async (req: AuthRequest, res: Response) => {
  const kennelId = await callerKennel(req);
  const target = await queryOne<any>(
    `SELECT id, role, active FROM users WHERE id = $1 AND kennel_id = $2`,
    [req.params.id, kennelId]
  );
  if (!target) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const nextRole = req.body?.role === 'owner' || req.body?.role === 'staff' ? req.body.role : target.role;
  const nextActive = typeof req.body?.active === 'boolean' ? req.body.active : target.active;

  // never leave the kennel without an active owner
  if ((target.role === 'owner' && nextRole !== 'owner') || (target.role === 'owner' && nextActive === false)) {
    const owners = await queryOne<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM users WHERE kennel_id = $1 AND role = 'owner' AND active = true AND id <> $2`,
      [kennelId, target.id]
    );
    if ((owners?.n ?? 0) === 0) {
      res.status(400).json({ error: 'The kennel must keep at least one active owner' });
      return;
    }
  }
  if (target.id === req.user!.id && nextActive === false) {
    res.status(400).json({ error: 'You cannot deactivate yourself' });
    return;
  }

  const row = await queryOne<any>(
    `UPDATE users SET role = $2, active = $3, updated_at = NOW()
      WHERE id = $1 RETURNING id, email, name, role, active`,
    [target.id, nextRole, nextActive]
  );
  if (nextActive === false) await revokeAllForUser(target.id);
  res.json({ user: row });
});

export default router;
