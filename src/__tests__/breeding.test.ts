/**
 * Phase 6 — breeding calendar: pure maths + the reminder sweep.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { BREEDER_DDL } from '../breeder/schema.js';
import {
  heatIntervalDays,
  predictNextHeat,
  fertileWindow,
  dueFromMating,
  progesteroneGuidance,
} from '../breeder/logic/breeding.js';

const db = new PGlite();
vi.mock('../database/index.js', () => ({
  query: async (t: string, p?: unknown[]) => (await db.query(t, p as unknown[])).rows,
  queryOne: async (t: string, p?: unknown[]) => (await db.query(t, p as unknown[])).rows[0] ?? null,
  execute: async (t: string, p?: unknown[]) => {
    await db.query(t, p as unknown[]);
  },
  pool: {},
}));
const { breedingSweep } = await import('../breeder/routes/breeding.js');

describe('pure maths', () => {
  it('heatIntervalDays averages recent gaps, defaults to 180', () => {
    expect(heatIntervalDays(['2026-01-01'])).toBe(180);
    expect(heatIntervalDays(['2025-01-01', '2025-07-01', '2026-01-01'])).toBe(183);
  });
  it('predictNextHeat projects from the last season', () => {
    const p = predictNextHeat(['2025-07-04', '2026-01-04']);
    expect(p?.intervalDays).toBe(184);
    expect(p?.nextStart).toBe('2026-07-07');
    expect(predictNextHeat([])).toBeNull();
  });
  it('fertileWindow is days 9 to 15', () => {
    expect(fertileWindow('2026-03-01')).toEqual({ from: '2026-03-10', to: '2026-03-16' });
  });
  it('dueFromMating adds 63 days', () => {
    expect(dueFromMating('2026-03-01')).toBe('2026-05-03');
  });
  it('progesteroneGuidance phases by ng/mL', () => {
    expect(progesteroneGuidance([]).phase).toBe('none');
    expect(progesteroneGuidance([{ on: '2026-03-01', ngml: 1 }]).phase).toBe('pre-surge');
    expect(progesteroneGuidance([{ on: '2026-03-01', ngml: 3 }]).phase).toBe('surge');
    const ov = progesteroneGuidance([{ on: '2026-03-01', ngml: 8 }]);
    expect(ov.phase).toBe('ovulation');
    expect(ov.breedOn).toBe('2026-03-03');
    expect(progesteroneGuidance([{ on: '2026-03-01', ngml: 40 }]).phase).toBe('post-ovulation');
    // no em dashes leak into the notes
    expect(ov.note).not.toContain('—');
  });
});

beforeAll(async () => {
  await db.exec(`
    CREATE TABLE users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email VARCHAR(255), role VARCHAR(20), kennel_id VARCHAR(255));
    CREATE TABLE devices (device_id VARCHAR(255) PRIMARY KEY, kennel_id VARCHAR(255));
  `);
  await db.exec(BREEDER_DDL);
  await db.exec(`
    CREATE TABLE heat_cycles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), kennel_id VARCHAR(255) NOT NULL,
      animal_id UUID NOT NULL, started_on DATE NOT NULL, ended_on DATE, notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW());
  `);
});

describe('breedingSweep', () => {
  it('raises heat-due for a dam whose season is imminent, and whelping-soon for a due litter', async () => {
    await db.query(
      `INSERT INTO animals (id, kennel_id, name, sex, role) VALUES
        ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','home','Willow','female','breeding')`,
    );
    // two seasons ~184 days apart, the last one 180 days ago → next is ~now
    await db.query(
      `INSERT INTO heat_cycles (kennel_id, animal_id, started_on) VALUES
        ('home','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', CURRENT_DATE - 364),
        ('home','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', CURRENT_DATE - 180)`,
    );
    await db.query(
      `INSERT INTO litters (kennel_id, name, due_on) VALUES ('home','Test litter', CURRENT_DATE + 3)`,
    );

    const r = await breedingSweep();
    expect(r.raised).toBe(2);

    const kinds = (await db.query<{ kind: string }>(`SELECT kind FROM exceptions ORDER BY kind`)).rows.map((x) => x.kind);
    expect(kinds).toEqual(['heat-due', 'whelping-soon']);

    // deduped
    await breedingSweep();
    expect((await db.query(`SELECT id FROM exceptions`)).rows).toHaveLength(2);
  });
});
