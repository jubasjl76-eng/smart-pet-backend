/**
 * First-run setup for a single breeding operation.
 *
 *   GET  /api/setup/status     what's done, what's next (drives the wizard)
 *   POST /api/setup/kennel     create / update THE kennel (owner)
 *   POST /api/setup/complete   mark setup finished
 *   POST /api/setup/seed-demo  one-shot: a few pens + a dam + a sire + preset rules
 *
 * Pens / dogs / preset rules already have endpoints under /api/breeder/*; the
 * wizard just calls them. This module only adds the kennel record + the flag.
 */
import { Router, type Response } from 'express';
import { query, queryOne, execute } from '../database/index.js';
import { auth, type AuthRequest } from '../middleware/auth.js';
import { presetRules } from '../breeder/logic/rules.js';

const router = Router();
router.use(auth);

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'kennel';
}

async function theKennel(): Promise<any | null> {
  return queryOne<any>(`SELECT * FROM kennels ORDER BY created_at LIMIT 1`);
}

/** The caller may administer the kennel if they own it, or if none exists yet and they're an owner. */
async function canAdminKennel(req: AuthRequest, kennel: any | null): Promise<boolean> {
  if (!req.user) return false;
  if (!kennel) return req.user.role === 'owner';
  return kennel.owner_user_id === req.user.id || req.user.role === 'owner';
}

router.get('/status', async (req: AuthRequest, res: Response) => {
  const kennel = await theKennel();
  const kennelId = kennel?.slug ?? null;
  const counts = kennelId
    ? await queryOne<any>(
        `SELECT
           (SELECT COUNT(*) FROM pens    WHERE kennel_id = $1)::int AS pens,
           (SELECT COUNT(*) FROM animals WHERE kennel_id = $1)::int AS animals,
           (SELECT COUNT(*) FROM rules   WHERE kennel_id = $1)::int AS rules,
           (SELECT COUNT(*) FROM devices WHERE kennel_id = $1)::int AS devices`,
        [kennelId]
      )
    : { pens: 0, animals: 0, rules: 0, devices: 0 };

  res.json({
    setupComplete: !!kennel?.setup_complete,
    canAdminister: await canAdminKennel(req, kennel),
    kennel: kennel
      ? { slug: kennel.slug, name: kennel.name, breedFocus: kennel.breed_focus, timezone: kennel.timezone }
      : null,
    steps: {
      kennel: !!kennel,
      pens: counts.pens > 0,
      animals: counts.animals > 0,
      rules: counts.rules > 0,
      devices: counts.devices > 0,
    },
    counts,
  });
});

router.post('/kennel', async (req: AuthRequest, res: Response) => {
  const kennel = await theKennel();
  if (!(await canAdminKennel(req, kennel))) {
    res.status(403).json({ error: 'Only the kennel owner can do this' });
    return;
  }
  const name = String(req.body?.name || '').trim();
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  const breedFocus = req.body?.breedFocus ? String(req.body.breedFocus).trim() : null;
  const timezone = req.body?.timezone ? String(req.body.timezone).trim() : 'UTC';

  let row: any;
  if (!kennel) {
    const slug = process.env.BREEDER_KENNEL_SLUG || slugify(name);
    row = await queryOne<any>(
      `INSERT INTO kennels (slug, name, owner_user_id, breed_focus, timezone)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [slug, name, req.user!.id, breedFocus, timezone]
    );
  } else {
    row = await queryOne<any>(
      `UPDATE kennels SET name = $2, breed_focus = $3, timezone = $4,
              owner_user_id = COALESCE(owner_user_id, $5)
        WHERE id = $1 RETURNING *`,
      [kennel.id, name, breedFocus, timezone, req.user!.id]
    );
  }
  // bind every user with no kennel to this one (single-operation model)
  await execute(`UPDATE users SET kennel_id = $1 WHERE kennel_id IS NULL`, [row.slug]);
  await execute(`UPDATE users SET kennel_id = $1 WHERE id = $2`, [row.slug, req.user!.id]);

  res.status(kennel ? 200 : 201).json({
    kennel: { slug: row.slug, name: row.name, breedFocus: row.breed_focus, timezone: row.timezone },
  });
});

router.post('/complete', async (req: AuthRequest, res: Response) => {
  const kennel = await theKennel();
  if (!kennel) {
    res.status(400).json({ error: 'Create the kennel first' });
    return;
  }
  if (!(await canAdminKennel(req, kennel))) {
    res.status(403).json({ error: 'Only the kennel owner can do this' });
    return;
  }
  await execute(
    `UPDATE kennels SET setup_complete = true, setup_completed_at = NOW() WHERE id = $1`,
    [kennel.id]
  );
  res.json({ setupComplete: true });
});

router.post('/seed-demo', async (req: AuthRequest, res: Response) => {
  const kennel = await theKennel();
  if (!kennel) {
    res.status(400).json({ error: 'Create the kennel first' });
    return;
  }
  if (!(await canAdminKennel(req, kennel))) {
    res.status(403).json({ error: 'Only the kennel owner can do this' });
    return;
  }
  const k = kennel.slug;
  const created: Record<string, number> = { pens: 0, animals: 0, rules: 0 };

  for (const [name, kind] of [['Whelping 1', 'whelping'], ['Run A', 'run'], ['Run B', 'run'], ['Yard', 'yard']] as const) {
    const exists = await queryOne(`SELECT id FROM pens WHERE kennel_id = $1 AND name = $2`, [k, name]);
    if (!exists) {
      await execute(`INSERT INTO pens (kennel_id, name, kind) VALUES ($1, $2, $3)`, [k, name, kind]);
      created.pens++;
    }
  }
  for (const [name, sex] of [['Bella', 'female'], ['Rocky', 'male']] as const) {
    const exists = await queryOne(`SELECT id FROM animals WHERE kennel_id = $1 AND name = $2`, [k, name]);
    if (!exists) {
      await execute(
        `INSERT INTO animals (kennel_id, name, sex, role, adult_weight_kg) VALUES ($1, $2, $3, 'breeding', 28)`,
        [k, name, sex]
      );
      created.animals++;
    }
  }
  const have = new Set((await query<{ name: string }>(`SELECT name FROM rules WHERE kennel_id = $1`, [k])).map((r) => r.name));
  for (const p of presetRules(k)) {
    if (have.has(p.name)) continue;
    await execute(
      `INSERT INTO rules (kennel_id, name, enabled, trigger, conditions, actions, cooldown_seconds)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [k, p.name, p.enabled, JSON.stringify(p.trigger), JSON.stringify(p.conditions), JSON.stringify(p.actions), p.cooldownSeconds]
    );
    created.rules++;
  }
  res.json({ seeded: created });
});

export default router;
