/**
 * Phase 5 slice 2 — buyer messaging + update-pack sweep.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { BREEDER_DDL } from '../breeder/schema.js';
import { renderUpdatePack, nextWeeklyRun, personalize } from '../breeder/logic/buyerComms.js';

const db = new PGlite();
vi.mock('../database/index.js', () => ({
  query: async (t: string, p?: unknown[]) => (await db.query(t, p as unknown[])).rows,
  queryOne: async (t: string, p?: unknown[]) => (await db.query(t, p as unknown[])).rows[0] ?? null,
  execute: async (t: string, p?: unknown[]) => {
    await db.query(t, p as unknown[]);
  },
  pool: {},
}));
const { updatePackSweep } = await import('../breeder/routes/buyerComms.js');

describe('pure helpers', () => {
  it('nextWeeklyRun adds 7 days', () => {
    expect(nextWeeklyRun(new Date('2026-01-01T00:00:00Z')).toISOString()).toBe('2026-01-08T00:00:00.000Z');
  });
  it('personalize swaps {name} for the first name', () => {
    expect(personalize('Hi {name}, news!', 'The Nolan Family')).toBe('Hi The, news!');
    expect(personalize('Hi {name}', null)).toBe('Hi there');
  });
  it('renderUpdatePack builds a subject + body with the facts it has', () => {
    const { subject, body } = renderUpdatePack({
      puppyName: 'Green collar',
      buyerName: 'Aoife',
      latestGrams: 5100,
      gainPerDay: 92.4,
      weeksOld: 7,
      photos: ['https://x/1.jpg'],
      goHomeOn: '2026-09-20',
    });
    expect(subject).toBe("Green collar: this week's update");
    expect(body).toContain('Hi Aoife,');
    expect(body).toContain('Age: 7 weeks.');
    expect(body).toContain('Weight: 5100 g (about +92 g a day).');
    expect(body).toContain('https://x/1.jpg');
    expect(body).toContain('Go-home date: 2026-09-20.');
    expect(body).not.toContain('—');
  });
});

beforeAll(async () => {
  await db.exec(`
    CREATE TABLE users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email VARCHAR(255), role VARCHAR(20), kennel_id VARCHAR(255));
    CREATE TABLE devices (device_id VARCHAR(255) PRIMARY KEY, kennel_id VARCHAR(255));
  `);
  await db.exec(BREEDER_DDL);
  // columns added by later migrations that the sweep reads
  await db.exec(`ALTER TABLE puppies ADD COLUMN IF NOT EXISTS photos JSONB DEFAULT '[]'::jsonb;`);
  await db.exec(`
    CREATE TABLE buyer_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), kennel_id VARCHAR(255) NOT NULL,
      buyer_id UUID, litter_id UUID, puppy_id UUID,
      kind VARCHAR(20) NOT NULL DEFAULT 'direct', subject VARCHAR(255), body TEXT,
      notification_id UUID, created_by UUID, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE update_pack_subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), kennel_id VARCHAR(255) NOT NULL,
      buyer_id UUID NOT NULL, puppy_id UUID NOT NULL, cadence VARCHAR(16) NOT NULL DEFAULT 'weekly',
      next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_sent_at TIMESTAMPTZ,
      active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (buyer_id, puppy_id));
  `);
});

describe('updatePackSweep', () => {
  it('queues one update-pack message per due subscription and pushes next_run_at a week out', async () => {
    await db.query(`INSERT INTO litters (id, kennel_id, name, whelped_at) VALUES
      ('22222222-2222-2222-2222-222222222222','home','L1', NOW() - INTERVAL '49 days')`);
    await db.query(`INSERT INTO puppies (id, kennel_id, litter_id, name, photos) VALUES
      ('33333333-3333-3333-3333-333333333333','home','22222222-2222-2222-2222-222222222222','Green', '["https://x/p.jpg"]'::jsonb)`);
    await db.query(`INSERT INTO buyers (id, kennel_id, name, email) VALUES
      ('44444444-4444-4444-4444-444444444444','home','Aoife M.','aoife@example.com')`);
    await db.query(`INSERT INTO weight_readings (kennel_id, puppy_id, grams, taken_at) VALUES
      ('home','33333333-3333-3333-3333-333333333333', 480, NOW() - INTERVAL '40 days'),
      ('home','33333333-3333-3333-3333-333333333333', 5000, NOW() - INTERVAL '2 days')`);
    await db.query(`INSERT INTO update_pack_subscriptions (kennel_id, buyer_id, puppy_id, next_run_at) VALUES
      ('home','44444444-4444-4444-4444-444444444444','33333333-3333-3333-3333-333333333333', NOW() - INTERVAL '1 hour')`);

    const r = await updatePackSweep();
    expect(r.sent).toBe(1);

    const msg = (await db.query<{ kind: string; subject: string; body: string }>(
      `SELECT kind, subject, body FROM buyer_messages`,
    )).rows;
    expect(msg).toHaveLength(1);
    expect(msg[0].kind).toBe('update-pack');
    expect(msg[0].body).toContain('Green');

    const note = (await db.query<{ channel: string; target: string }>(
      `SELECT channel, target FROM notifications`,
    )).rows;
    expect(note[0].channel).toBe('email');
    expect(note[0].target).toBe('aoife@example.com');

    // not due again immediately
    expect((await updatePackSweep()).sent).toBe(0);
  });
});
