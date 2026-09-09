/**
 * Full kennel for the breeder console. Idempotent. Called from `npm run seed`
 * (and POST /api/setup/seed-demo). Add a block here when a new console screen
 * needs rows to click.
 */
import { query, queryOne, execute } from './index.js';
import { DEFAULT_PROTOCOL, scheduleFromProtocol } from '../breeder/logic/vaccinations.js';
import { DEFAULT_TEMPLATES, buildDoc } from '../breeder/logic/docTemplates.js';

const BREED = 'Golden Retriever';
const HEALTH = JSON.stringify([
  { name: 'Hips (BVA/KC)', result: '3:3' },
  { name: 'Elbows', result: '0:0' },
  { name: 'Eyes (annual)', result: 'Clear (2026)' },
  { name: 'prcd-PRA', result: 'Clear (DNA)' },
]);

async function named(slug: string, table: string, name: string): Promise<{ id: string } | null> {
  return queryOne<{ id: string }>(`SELECT id FROM ${table} WHERE kennel_id = $1 AND name = $2`, [slug, name]);
}

async function dog(
  slug: string,
  name: string,
  fields: Record<string, unknown>,
): Promise<string> {
  const existing = await named(slug, 'animals', name);
  if (existing) return existing.id;
  const cols = ['kennel_id', 'name', ...Object.keys(fields)];
  const vals = [slug, name, ...Object.values(fields)];
  const row = await queryOne<{ id: string }>(
    `INSERT INTO animals (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
    vals,
  );
  return row!.id;
}

export async function seedConsole(slug: string): Promise<void> {
  const owner = await queryOne<{ id: string; email: string }>(
    `SELECT id, email FROM users WHERE kennel_id = $1 AND role = 'owner' ORDER BY created_at LIMIT 1`,
    [slug],
  );

  if (!(await named(slug, 'pens', 'Nursery'))) {
    await execute(`INSERT INTO pens (kennel_id, name, kind, capacity) VALUES ($1, 'Nursery', 'whelping', 6)`, [slug]);
  }

  const pen = async (name: string) =>
    (await queryOne<{ id: string }>(`SELECT id FROM pens WHERE kennel_id = $1 AND name = $2`, [slug, name]))?.id ?? null;

  const whelping = await pen('Whelping 1');
  const runA = await pen('Run A');
  const runB = await pen('Run B');
  const yard = await pen('Yard');

  const magnus = await dog(slug, 'Magnus', { sex: 'male', role: 'retired', breed: BREED, dob: '2018-03-11', adult_weight_kg: 34, registration_no: 'IKC-MAG-18', current_pen_id: yard });
  const freya = await dog(slug, 'Freya', { sex: 'female', role: 'retired', breed: BREED, dob: '2018-06-02', adult_weight_kg: 28, registration_no: 'IKC-FRE-18', current_pen_id: yard });
  const thor = await dog(slug, 'Thor', { sex: 'male', role: 'retired', breed: BREED, dob: '2017-11-20', adult_weight_kg: 36, registration_no: 'IKC-THO-17', current_pen_id: runB });
  const astrid = await dog(slug, 'Astrid', { sex: 'female', role: 'retired', breed: BREED, dob: '2019-01-08', adult_weight_kg: 27, registration_no: 'IKC-AST-19', current_pen_id: runB });
  const maple = await dog(slug, 'Maple', {
    sex: 'female', role: 'breeding', breed: BREED, dob: '2022-04-15', adult_weight_kg: 29,
    registration_no: 'IKC-MAP-22', sire_id: magnus, dam_id: freya, current_pen_id: whelping,
  });
  const atlas = await dog(slug, 'Atlas', {
    sex: 'male', role: 'breeding', breed: BREED, dob: '2021-09-03', adult_weight_kg: 33,
    registration_no: 'IKC-ATL-21', sire_id: thor, dam_id: astrid, current_pen_id: runA,
  });
  for (const id of [maple, atlas, magnus, freya]) {
    await execute(
      `UPDATE animals SET published = true, titles = COALESCE(titles, 'IKC registered') WHERE id = $1`,
      [id],
    ).catch(() => {});
    await execute(
      `UPDATE animals SET health_tests = $2::jsonb WHERE id = $1 AND health_tests = '[]'::jsonb`,
      [id, HEALTH],
    ).catch(() => {});
  }

  await execute(
    `INSERT INTO care_plans (animal_id, kennel_id, food_sku, grams_per_day, meals_per_day, diet_notes, vet_name, vet_phone, emergency_contact, emergency_phone)
     VALUES ($1,$2,'Orijen Adult 28/18',420,2,'Soaked kibble in the whelping room.','Meath Vet Hospital','+353 46 902 0000','Owner','+353 86 100 0000')
     ON CONFLICT (animal_id) DO NOTHING`,
    [maple, slug],
  ).catch(() => {});

  const weightN = await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM weight_readings WHERE animal_id = $1`, [maple]);
  if ((weightN?.n ?? 0) < 3) {
    for (const [g, days] of [[28500, 90], [29000, 30], [29200, 0]] as const) {
      await execute(
        `INSERT INTO weight_readings (kennel_id, animal_id, grams, source, taken_at)
         VALUES ($1,$2,$3,'manual', NOW() - make_interval(days => $4))`,
        [slug, maple, g, days],
      );
    }
  }

  let spring = await named(slug, 'litters', 'Maple x Atlas, Spring');
  if (!spring) {
    spring = await queryOne<{ id: string }>(
      `INSERT INTO litters
         (kennel_id, name, dam_id, sire_id, pen_id, mated_on, due_on, whelped_at, count_born, count_alive, status)
       VALUES ($1,'Maple x Atlas, Spring',$2,$3,$4, CURRENT_DATE - 113, CURRENT_DATE - 50,
               NOW() - INTERVAL '50 days', 4, 4, 'whelped')
       RETURNING id`,
      [slug, maple, atlas, whelping],
    );
    await execute(
      `UPDATE litters SET mating_method = 'natural',
              progesterone = '[{"on":"2026-05-18","ngml":4.8}]'::jsonb,
              published = true,
              public_description = 'Four puppies raised in the kitchen. Ready at eight weeks.'
       WHERE id = $1`,
      [spring!.id],
    ).catch(() => {});
  }

  let next = await named(slug, 'litters', 'Maple x Atlas, next');
  if (!next) {
    next = await queryOne<{ id: string }>(
      `INSERT INTO litters
         (kennel_id, name, dam_id, sire_id, mated_on, due_on, status, notes)
       VALUES ($1,'Maple x Atlas, next',$2,$3, CURRENT_DATE - 5, CURRENT_DATE + 58, 'expecting', 'Planned repeat')
       RETURNING id`,
      [slug, maple, atlas],
    );
    await execute(
      `UPDATE litters SET mating_method = 'AI',
              progesterone = '[{"on":"2026-09-02","ngml":2.1},{"on":"2026-09-04","ngml":6.4}]'::jsonb
       WHERE id = $1`,
      [next!.id],
    ).catch(() => {});
  }

  const heats = await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM heat_cycles WHERE animal_id = $1`, [maple]).catch(() => ({ n: 0 }));
  if ((heats?.n ?? 0) === 0) {
    await execute(
      `INSERT INTO heat_cycles (kennel_id, animal_id, started_on, ended_on, notes)
       VALUES ($1, $2, CURRENT_DATE - 400, CURRENT_DATE - 379, 'Previous season')`,
      [slug, maple],
    ).catch(() => {});
  }
  if ((heats?.n ?? 0) < 2) {
    await execute(
      `INSERT INTO heat_cycles (kennel_id, animal_id, started_on, ended_on, notes)
       VALUES ($1, $2, CURRENT_DATE - 220, CURRENT_DATE - 200, 'Bred this season')`,
      [slug, maple],
    ).catch(() => {});
  }

  const pupSpecs = [
    { name: 'Red collar', sex: 'male', color: 'Gold', status: 'reserved', chip: '941000012345678', goHome: 8, grams: [420, 1200, 2400, 3800] },
    { name: 'White collar', sex: 'female', color: 'Cream', status: 'available', chip: null, goHome: null, grams: [390, 1180, 2350, 3700] },
    { name: 'Pink collar', sex: 'female', color: 'Gold', status: 'reserved', chip: '941000012345679', goHome: 10, grams: [405, 1210, 2420, 3850] },
    { name: 'Black collar', sex: 'male', color: 'Dark gold', status: 'available', chip: null, goHome: null, grams: [440, 1300, 2500, 3950] },
  ] as const;

  const pupIds: Record<string, string> = {};
  if (spring) {
    for (const p of pupSpecs) {
      let pup = await queryOne<{ id: string }>(
        `SELECT id FROM puppies WHERE kennel_id = $1 AND litter_id = $2 AND name = $3`,
        [slug, spring.id, p.name],
      );
      if (!pup) {
        pup = await queryOne<{ id: string }>(
          `INSERT INTO puppies
             (kennel_id, litter_id, name, collar_color, sex, status, microchip, go_home_on, birth_weight_g)
           VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $8::int IS NULL THEN NULL ELSE CURRENT_DATE + ($8::int) END, $9)
           RETURNING id`,
          [slug, spring.id, p.name, p.name.split(' ')[0], p.sex, p.status, p.chip, p.goHome, p.grams[0]],
        );
        await execute(
          `UPDATE puppies SET color = $2, published = true WHERE id = $1`,
          [pup!.id, p.color],
        ).catch(() => {});
      }
      pupIds[p.name] = pup!.id;
      const wn = await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM weight_readings WHERE puppy_id = $1`, [pup!.id]);
      if ((wn?.n ?? 0) < p.grams.length) {
        for (let i = 0; i < p.grams.length; i++) {
          await execute(
            `INSERT INTO weight_readings (kennel_id, puppy_id, grams, source, taken_at)
             VALUES ($1,$2,$3,'manual', NOW() - INTERVAL '50 days' + make_interval(days => $4))`,
            [slug, pup!.id, p.grams[i], i * 14],
          );
        }
      }
    }
  }

  const buyer = async (name: string, email: string, phone: string, city: string, status: string, extra: Record<string, unknown> = {}) => {
    const hit = await named(slug, 'buyers', name);
    if (hit) return hit.id;
    const row = await queryOne<{ id: string }>(
      `INSERT INTO buyers (kennel_id, name, email, phone, city, status, deposit_paid, wants_litter_id, waitlist_rank)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [slug, name, email, phone, city, status, extra.deposit ?? false, extra.litter ?? spring?.id ?? null, extra.rank ?? 1],
    );
    return row!.id;
  };

  const aoife = await buyer('Aoife Murphy', 'aoife@example.com', '+353 86 111 1111', 'Navan', 'reserved', { deposit: true, rank: 1 });
  const sarah = await buyer('Sarah Kelly', 'sarah@example.com', '+353 87 222 2222', 'Trim', 'reserved', { deposit: true, rank: 2 });
  await buyer('Tom Byrne', 'tom@example.com', '+353 85 333 3333', 'Kells', 'waitlist', { rank: 3 });

  const red = pupIds['Red collar'];
  const pink = pupIds['Pink collar'];
  if (red) {
    await execute(`UPDATE buyers SET puppy_id = $2, status = 'reserved', deposit_paid = true WHERE id = $1`, [aoife, red]);
    await execute(`UPDATE puppies SET buyer_id = $2, status = 'reserved' WHERE id = $1`, [red, aoife]);
  }
  if (pink) {
    await execute(`UPDATE buyers SET puppy_id = $2, status = 'reserved', deposit_paid = true WHERE id = $1`, [sarah, pink]);
    await execute(`UPDATE puppies SET buyer_id = $2, status = 'reserved' WHERE id = $1`, [pink, sarah]);
  }

  const haveMsg = await queryOne(`SELECT id FROM buyer_messages WHERE kennel_id = $1 LIMIT 1`, [slug]).catch(() => null);
  if (!haveMsg) {
    await execute(
      `INSERT INTO buyer_messages (kennel_id, buyer_id, litter_id, kind, subject, body, created_by)
       VALUES ($1, $2, $3, 'broadcast', 'Litter update', 'Hi Aoife, the Spring litter is thriving — photos this weekend.', $4)`,
      [slug, aoife, spring?.id ?? null, owner?.id ?? null],
    ).catch(() => {});
  }
  if (red) {
    await execute(
      `INSERT INTO update_pack_subscriptions (kennel_id, buyer_id, puppy_id)
       VALUES ($1,$2,$3) ON CONFLICT (buyer_id, puppy_id) DO NOTHING`,
      [slug, aoife, red],
    ).catch(() => {});
  }

  const protocol = await queryOne<{ id: string; doses: typeof DEFAULT_PROTOCOL }>(
    `SELECT id, doses FROM vaccination_protocols WHERE kennel_id = $1 AND is_default = true LIMIT 1`,
    [slug],
  );
  const whelpedAt = await queryOne<{ whelped_at: string }>(
    `SELECT whelped_at::text FROM litters WHERE id = $1`, [spring?.id],
  );
  if (protocol && whelpedAt?.whelped_at && spring) {
    const pups = await query<{ id: string }>(`SELECT id FROM puppies WHERE litter_id = $1`, [spring.id]);
    const given = new Set(['Worming (2 weeks)', 'Worming (4 weeks)', 'Worming (6 weeks)', 'DHP/L primary']);
    for (const pu of pups) {
      const have = new Set(
        (await query<{ name: string }>(`SELECT name FROM vaccination_records WHERE puppy_id = $1`, [pu.id])).map((r) => r.name),
      );
      for (const row of scheduleFromProtocol(whelpedAt.whelped_at, protocol.doses ?? DEFAULT_PROTOCOL)) {
        if (have.has(row.name)) continue;
        await execute(
          `INSERT INTO vaccination_records (kennel_id, puppy_id, protocol_id, name, kind, due_on, given_on, batch_no, vet_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            slug, pu.id, protocol.id, row.name, row.kind, row.dueOn,
            given.has(row.name) ? row.dueOn : null,
            given.has(row.name) ? 'DEMO-1' : null,
            given.has(row.name) ? 'Meath Vet Hospital' : null,
          ],
        );
      }
    }
  }

  for (const [animalId, name] of [[magnus, 'Magnus'], [freya, 'Freya'], [maple, 'Maple'], [atlas, 'Atlas']] as const) {
    const have = await queryOne(`SELECT id FROM documents WHERE subject_id = $1 AND kind = 'registration'`, [animalId]).catch(() => null);
    if (have) continue;
    await execute(
      `INSERT INTO documents (kennel_id, kind, subject_type, subject_id, title, filename, content_type, body)
       VALUES ($1, 'registration', 'animal', $2, $3, $4, 'text/plain', $5)`,
      [slug, animalId, `${name} IKC registration`, `${name}-registration.txt`, `IKC registration — ${name}`],
    ).catch(() => {});
  }

  const haveTpl = await queryOne(`SELECT slug FROM document_templates WHERE kennel_id = $1 AND slug = 'contract'`, [slug]).catch(() => null);
  if (!haveTpl) {
    await execute(
      `INSERT INTO document_templates (kennel_id, slug, title, body, updated_by)
       VALUES ($1, 'contract', $2, $3, $4)`,
      [
        slug,
        DEFAULT_TEMPLATES[0].title,
        `${DEFAULT_TEMPLATES[0].body}\n\nKennel copy: keep with the go-home pack.\n`,
        owner?.id ?? null,
      ],
    ).catch(() => {});
  }

  if (red) {
    const haveKinds = new Set(
      (await query<{ kind: string }>(`SELECT kind FROM documents WHERE subject_type = 'puppy' AND subject_id = $1`, [red])).map((d) => d.kind),
    );
    const auto = {
      today: new Date().toISOString().slice(0, 10),
      kennel_name: 'Home Kennel',
      puppy_name: 'Red collar',
      puppy_sex: 'male',
      puppy_color: 'Gold',
      microchip: '941000012345678',
      go_home_on: 'soon',
      breed: BREED,
      birth_date: new Date(Date.now() - 50 * 86400000).toISOString().slice(0, 10),
      dam_name: 'Maple',
      sire_name: 'Atlas',
      buyer_name: 'Aoife Murphy',
      buyer_email: 'aoife@example.com',
      price: '€2,200',
      deposit: '€500',
      balance: '€1,700',
    };
    for (const tpl of DEFAULT_TEMPLATES) {
      if (haveKinds.has(tpl.kind)) continue;
      try {
        const doc = buildDoc(tpl, auto, {});
        await execute(
          `INSERT INTO documents (kennel_id, kind, subject_type, subject_id, title, filename, content_type, body, meta)
           VALUES ($1,$2,'puppy',$3,$4,$5,'text/markdown',$6,$7::jsonb)`,
          [slug, doc.kind, red, doc.title, `${doc.title}.md`, doc.body, JSON.stringify({ template: tpl.slug, generated: true })],
        );
      } catch (e) {
        console.warn('[seed] generate', tpl.slug, (e as Error).message);
      }
    }
  }

  const med = await queryOne<{ id: string }>(
    `SELECT id FROM medications WHERE kennel_id = $1 AND animal_id = $2 AND name = 'Heartgard'`,
    [slug, maple],
  );
  if (!med) {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO medications (kennel_id, animal_id, name, dose, route, times_of_day, days_of_week, instructions)
       VALUES ($1,$2,'Heartgard','1 chew','oral', ARRAY['08:00'], ARRAY[0,1,2,3,4,5,6], 'With breakfast')
       RETURNING id`,
      [slug, maple],
    );
    if (row) {
      await execute(
        `INSERT INTO medication_logs (kennel_id, medication_id, animal_id, outcome, note, administered_by)
         VALUES ($1,$2,$3,'given','Taken well',$4)`,
        [slug, row.id, maple, owner?.id ?? null],
      );
    }
  }

  if (!(await named(slug, 'consumables', 'Adult kibble 28/18'))) {
    await execute(
      `INSERT INTO consumables (kennel_id, name, category, unit, on_hand, low_threshold, daily_use)
       VALUES ($1, 'Adult kibble 28/18', 'food', 'kg', 3, 10, 1.2)`,
      [slug],
    );
  }
  if (!(await named(slug, 'consumables', 'Dewormer tablets'))) {
    await execute(
      `INSERT INTO consumables (kennel_id, name, category, unit, on_hand, low_threshold, daily_use)
       VALUES ($1, 'Dewormer tablets', 'meds', 'tabs', 40, 8, 0.2)`,
      [slug],
    );
  }

  const devices = [
    ['dash-feeder-1', 'feeder', 'Whelping feeder', whelping],
    ['dash-water-1', 'water', 'Run A water', runA],
    ['dash-scale-1', 'scale', 'Nursery scale', await pen('Nursery')],
  ] as const;
  for (const [deviceId, type, name, penId] of devices) {
    await execute(
      `INSERT INTO devices (device_id, device_type, name, kennel_id, pen_id, status, is_online, claimed_at)
       VALUES ($1,$2,$3,$4,$5,'offline', false, NOW())
       ON CONFLICT (device_id) DO NOTHING`,
      [deviceId, type, name, slug, penId],
    ).catch(() => {});
  }
  const havePair = await queryOne(`SELECT code FROM device_pairings WHERE code = 'GPS-DEMO'`).catch(() => null);
  if (!havePair) {
    await execute(
      `INSERT INTO device_pairings (code, kennel_id, device_type, suggested_name, expires_at)
       VALUES ('GPS-DEMO', $1, 'gps', 'Yard collar (unclaimed)', NOW() + INTERVAL '7 days')`,
      [slug],
    ).catch(() => {});
  }

  if (owner) {
    await execute(
      `INSERT INTO notification_prefs (user_id, kennel_id, channels, quiet_hours, escalation, email)
       VALUES ($1,$2,'["log","email"]'::jsonb, '{"start":"22:00","end":"07:00","overrideSeverity":"critical"}'::jsonb,
               '[{"afterSeconds":900,"channel":"log"}]'::jsonb, $3)
       ON CONFLICT (user_id) DO NOTHING`,
      [owner.id, slug, owner.email],
    ).catch(() => {});
  }

  const inbox = [
    ['temp-high', 'critical', 90, 'Whelping 1 is 29 C', 'Probe in the whelping box.', whelping, null, 'Turn on the fan and crack a window.', 'escalated'],
    ['low-battery', 'warning', 60, 'Nursery scale battery 12%', null, null, null, 'Swap the cells this evening.', 'open'],
    ['weight-drop', 'warning', 55, 'Maple is off her curve', null, null, maple, 'Recheck at the next meal.', 'open'],
    ['consumable-low', 'warning', 50, 'Adult kibble 28/18 running low', 'About two days of stock left.', null, null, 'Buy more and update the on-hand count.', 'open'],
  ] as const;
  for (const [kind, severity, priority, title, detail, penId, animalId, action, status] of inbox) {
    const key = `seed:${kind}`;
    const have = await queryOne(`SELECT id FROM exceptions WHERE kennel_id = $1 AND dedup_key = $2`, [slug, key]);
    if (have) continue;
    await execute(
      `INSERT INTO exceptions
         (kennel_id, kind, severity, priority, title, detail, pen_id, animal_id, suggested_action, dedup_key, status, first_notified_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW())`,
      [slug, kind, severity, priority, title, detail, penId, animalId, action, key, status],
    );
  }

  const haveInvite = await queryOne(
    `SELECT token FROM user_invites WHERE email = $1 AND kennel_id = $2 AND accepted_at IS NULL`,
    ['staff-demo@smartpet.local', slug],
  ).catch(() => null);
  if (!haveInvite) {
    await execute(
      `INSERT INTO user_invites (token, email, role, kennel_id, invited_by, expires_at)
       VALUES ('seed-staff-invite', 'staff-demo@smartpet.local', 'staff', $1, $2, NOW() + INTERVAL '7 days')`,
      [slug, owner?.id ?? null],
    ).catch(() => {});
  }

  await execute(
    `UPDATE kennels SET setup_complete = true, setup_completed_at = COALESCE(setup_completed_at, NOW()),
            breed_focus = COALESCE(breed_focus, $2)
     WHERE slug = $1`,
    [slug, BREED],
  );

  if (owner) {
    const haveLog = await queryOne(`SELECT id FROM access_log WHERE kennel_id = $1 LIMIT 1`, [slug]).catch(() => null);
    if (!haveLog) {
      const aoifeId = (await named(slug, 'buyers', 'Aoife Murphy'))?.id ?? null;
      const mapleId = maple;
      await execute(
        `INSERT INTO access_log (kennel_id, user_id, action, subject_type, subject_id, ip, detail)
         VALUES ($1,$2,'document.download','animal',$3,'127.0.0.1','{"kind":"registration","seed":true}'::jsonb)`,
        [slug, owner.id, mapleId],
      ).catch(() => {});
      if (aoifeId) {
        await execute(
          `INSERT INTO access_log (kennel_id, user_id, action, subject_type, subject_id, ip, detail)
           VALUES ($1,$2,'privacy.export','buyer',$3,'127.0.0.1','{"seed":true}'::jsonb)`,
          [slug, owner.id, aoifeId],
        ).catch(() => {});
      }
    }
  }

  console.log('[seed] console demo ready (Maple pedigree, Spring litter, buyers, inbox, papers)');
}
