/**
 * Boot seed — runs on every startup, idempotent. Gives a fresh database enough
 * to log in and operate: an owner account, the kennel, its automation rules and
 * a basic set of pens. Demo animals only when SEED_DEMO=true.
 *
 * Env:
 *   SEED_OWNER_EMAIL / SEED_OWNER_PASSWORD   create the owner (skipped in
 *     production if no password is given — no weak default there)
 *   SEED_STAFF_EMAIL / SEED_STAFF_PASSWORD   optional staff account
 *   SEED_RULES=false   don't install preset rules
 *   SEED_PENS=false    don't create the starter pens
 *   SEED_DEMO=true     add a demo dam + sire and mark setup complete
 *   BREEDER_KENNEL_SLUG / BREEDER_KENNEL_NAME   the kennel identity
 */
import bcrypt from 'bcryptjs';
import { query, queryOne, execute } from './index.js';
import { presetRules } from '../breeder/logic/rules.js';

const isProd = process.env.NODE_ENV === 'production';

export interface SeedResult {
  ownerCreated: boolean;
  staffCreated: boolean;
  kennel: string;
  rulesInstalled: number;
  pensCreated: number;
  animalsCreated: number;
  setupComplete: boolean;
}

async function seedUser(
  email: string | undefined,
  password: string | undefined,
  role: 'owner' | 'staff',
  kennelSlug: string
): Promise<boolean> {
  if (!email) return false;
  const pass = password || (isProd ? undefined : `${role}-local-only`);
  if (!pass) {
    console.warn(`[seed] ${role} not seeded — set SEED_${role.toUpperCase()}_PASSWORD (no default in production)`);
    return false;
  }
  const existing = await queryOne<{ id: string }>('SELECT id FROM users WHERE lower(email) = lower($1)', [email]);
  if (existing) return false;
  await execute(
    `INSERT INTO users (email, password_hash, name, role, kennel_id, active)
     VALUES ($1, $2, $3, $4, $5, true)`,
    [email, await bcrypt.hash(pass, 10), role === 'owner' ? 'Owner' : 'Staff', role, kennelSlug]
  );
  return true;
}

export async function runSeed(opts: { demo?: boolean } = {}): Promise<SeedResult> {
  const slug = process.env.BREEDER_KENNEL_SLUG || 'home';
  const name = process.env.BREEDER_KENNEL_NAME || 'Home Kennel';
  const demo = opts.demo ?? process.env.SEED_DEMO === 'true';

  // ── kennel ────────────────────────────────────────────────────────────────
  await execute(
    `INSERT INTO kennels (slug, name) VALUES ($1, $2) ON CONFLICT (slug) DO NOTHING`,
    [slug, name]
  );

  // ── users ─────────────────────────────────────────────────────────────────
  const ownerCreated = await seedUser(process.env.SEED_OWNER_EMAIL, process.env.SEED_OWNER_PASSWORD, 'owner', slug);
  const staffCreated = await seedUser(process.env.SEED_STAFF_EMAIL, process.env.SEED_STAFF_PASSWORD, 'staff', slug);

  await execute(
    `UPDATE kennels k SET owner_user_id = u.id
       FROM users u
      WHERE k.slug = $1 AND k.owner_user_id IS NULL AND u.role = 'owner'`,
    [slug]
  );
  await execute(`UPDATE users SET kennel_id = $1 WHERE kennel_id IS NULL`, [slug]);

  // ── preset rules ──────────────────────────────────────────────────────────
  let rulesInstalled = 0;
  if (process.env.SEED_RULES !== 'false') {
    const have = new Set(
      (await query<{ name: string }>(`SELECT name FROM rules WHERE kennel_id = $1`, [slug])).map((r) => r.name)
    );
    for (const p of presetRules(slug)) {
      if (have.has(p.name)) continue;
      await execute(
        `INSERT INTO rules (kennel_id, name, enabled, trigger, conditions, actions, cooldown_seconds)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [slug, p.name, p.enabled, JSON.stringify(p.trigger), JSON.stringify(p.conditions),
         JSON.stringify(p.actions), p.cooldownSeconds]
      );
      rulesInstalled++;
    }
  }

  // ── starter pens ──────────────────────────────────────────────────────────
  let pensCreated = 0;
  if (process.env.SEED_PENS !== 'false') {
    const penCount = await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM pens WHERE kennel_id = $1`, [slug]);
    if ((penCount?.n ?? 0) === 0) {
      for (const [pn, kind] of [['Whelping 1', 'whelping'], ['Run A', 'run'], ['Run B', 'run'], ['Yard', 'yard']] as const) {
        await execute(`INSERT INTO pens (kennel_id, name, kind) VALUES ($1, $2, $3)`, [slug, pn, kind]);
        pensCreated++;
      }
    }
  }

  // ── demo animals ──────────────────────────────────────────────────────────
  let animalsCreated = 0;
  if (demo) {
    for (const [an, sex] of [['Bella', 'female'], ['Rocky', 'male']] as const) {
      const exists = await queryOne(`SELECT id FROM animals WHERE kennel_id = $1 AND name = $2`, [slug, an]);
      if (!exists) {
        await execute(
          `INSERT INTO animals (kennel_id, name, sex, role, adult_weight_kg) VALUES ($1, $2, $3, 'breeding', 28)`,
          [slug, an, sex]
        );
        animalsCreated++;
      }
    }
    await execute(
      `UPDATE kennels SET setup_complete = true, setup_completed_at = COALESCE(setup_completed_at, NOW()) WHERE slug = $1`,
      [slug]
    );
  }

  const k = await queryOne<{ setup_complete: boolean }>(`SELECT setup_complete FROM kennels WHERE slug = $1`, [slug]);
  const result: SeedResult = {
    ownerCreated, staffCreated, kennel: slug,
    rulesInstalled, pensCreated, animalsCreated,
    setupComplete: !!k?.setup_complete,
  };
  console.log(
    `[seed] kennel="${slug}" owner=${ownerCreated ? 'created' : 'kept'} ` +
    `rules+${rulesInstalled} pens+${pensCreated} animals+${animalsCreated}` +
    (result.setupComplete ? ' (setup complete)' : '')
  );
  return result;
}
