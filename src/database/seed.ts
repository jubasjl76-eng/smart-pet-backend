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
 *   SEED_DEMO=true     add a demo dam + sire, a published litter for the public
 *                     website, and mark setup complete
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

const PHOTO = (s: string) => `https://picsum.photos/seed/${s}/900/600`;
const DEMO_HEALTH = JSON.stringify([
  { name: 'Hips (BVA/KC)', result: '3:3' },
  { name: 'Elbows', result: '0:0' },
  { name: 'Eyes (annual)', result: 'Clear (2026)' },
  { name: 'prcd-PRA', result: 'Clear (DNA)' },
]);

/**
 * Publish the demo dam + sire and one litter so the public website shows a real
 * (small) kennel the moment the stack comes up. Idempotent; best-effort — a
 * pre-migration DB (old tests) just skips it.
 */
async function seedWebsiteDemo(slug: string): Promise<void> {
  await execute(
    `UPDATE kennels SET
       breed_focus     = COALESCE(breed_focus, 'Golden Retriever'),
       public_tagline  = COALESCE(public_tagline, 'Health-tested retrievers, raised underfoot in a working farmhouse.'),
       public_about    = COALESCE(public_about, 'A small family programme. One or two litters a year from fully health-tested parents, every puppy raised in the kitchen.'),
       public_email    = COALESCE(public_email, $2),
       public_location = COALESCE(public_location, 'County Meath, Ireland'),
       public_socials  = CASE WHEN public_socials = '[]'::jsonb
                              THEN '[{"label":"Instagram","url":"https://instagram.com/example"}]'::jsonb
                              ELSE public_socials END
     WHERE slug = $1`,
    [slug, process.env.SEED_OWNER_EMAIL || 'hello@example.com'],
  );

  for (const [name, dob, bio, photoSeed] of [
    ['Bella', '2021-05-20', 'Foundation girl. Biddable, soft-mouthed, and the first to greet anyone at the gate.', 'demo-bella'],
    ['Rocky', '2021-03-14', 'Blocky head, dense coat, an enormous will to please. Health-tested annually and used sparingly.', 'demo-rocky'],
  ] as const) {
    await execute(
      `UPDATE animals SET
         published = true,
         breed = COALESCE(breed, 'Golden Retriever'),
         dob = COALESCE(dob, $3::date),
         titles = COALESCE(titles, 'IKC registered'),
         bio = COALESCE(bio, $4),
         health_tests = CASE WHEN health_tests = '[]'::jsonb THEN $5::jsonb ELSE health_tests END,
         photos = CASE WHEN photos = '[]'::jsonb THEN $6::jsonb ELSE photos END
       WHERE kennel_id = $1 AND name = $2`,
      [slug, name, dob, bio, DEMO_HEALTH, JSON.stringify([PHOTO(photoSeed)])],
    );
  }

  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM litters WHERE kennel_id = $1 AND name = 'Bella x Rocky, Summer'`,
    [slug],
  );
  if (existing) return;

  const dam = await queryOne<{ id: string }>(`SELECT id FROM animals WHERE kennel_id=$1 AND name='Bella'`, [slug]);
  const sire = await queryOne<{ id: string }>(`SELECT id FROM animals WHERE kennel_id=$1 AND name='Rocky'`, [slug]);
  const litter = await queryOne<{ id: string }>(
    `INSERT INTO litters
       (kennel_id, name, dam_id, sire_id, status, whelped_at, count_born, count_alive, published, public_description, photos)
     VALUES ($1, 'Bella x Rocky, Summer', $2, $3, 'whelped', NOW() - INTERVAL '50 days', 5, 5, true, $4, $5::jsonb)
     RETURNING id`,
    [
      slug, dam?.id ?? null, sire?.id ?? null,
      'Five puppies raised in the kitchen with daily handling. Ready for their families at eight weeks, vet-checked and first-vaccinated.',
      JSON.stringify([PHOTO('demo-litter-1'), PHOTO('demo-litter-2')]),
    ],
  );
  if (!litter) return;

  const pups = [
    ['Green collar', 'male', 'Gold', 'available'],
    ['Blue collar', 'female', 'Cream', 'available'],
    ['Yellow collar', 'male', 'Gold', 'reserved'],
  ] as const;
  const grams = [480, 1900, 3400, 4900];
  for (const [pname, sex, color, status] of pups) {
    const pup = await queryOne<{ id: string }>(
      `INSERT INTO puppies (kennel_id, litter_id, name, collar_color, sex, color, status, published, photos)
       VALUES ($1,$2,$3,$3,$4,$5,$6,true,$7::jsonb) RETURNING id`,
      [slug, litter.id, pname, sex, color, status, JSON.stringify([PHOTO(`demo-pup-${pname.split(' ')[0].toLowerCase()}`)])],
    );
    if (!pup) continue;
    for (let i = 0; i < grams.length; i++) {
      await execute(
        `INSERT INTO weight_readings (kennel_id, puppy_id, grams, source, taken_at)
         VALUES ($1,$2,$3,'manual', NOW() - INTERVAL '50 days' + make_interval(days => $4))`,
        [slug, pup.id, grams[i], i * 14],
      );
    }
  }
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

    // Publish a small demo kennel for the public website (best-effort).
    try {
      await seedWebsiteDemo(slug);
    } catch (e) {
      console.warn('[seed] website demo skipped:', (e as Error).message);
    }
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
