/**
 * Phase 5 — vaccination scheduling: pure helpers + apply/sweep against pglite.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { BREEDER_DDL } from '../breeder/schema.js';
import { scheduleFromProtocol, recordStatus, DEFAULT_PROTOCOL } from '../breeder/logic/vaccinations.js';

const db = new PGlite();
vi.mock('../database/index.js', () => ({
  query: async (t: string, p?: unknown[]) => (await db.query(t, p as unknown[])).rows,
  queryOne: async (t: string, p?: unknown[]) => (await db.query(t, p as unknown[])).rows[0] ?? null,
  execute: async (t: string, p?: unknown[]) => {
    await db.query(t, p as unknown[]);
  },
  pool: {},
}));
const { vaccinationSweep } = await import('../breeder/routes/vaccinations.js');

describe('scheduleFromProtocol', () => {
  it('offsets each dose from the birth date', () => {
    const rows = scheduleFromProtocol('2026-01-01', [
      { name: 'A', atAgeDays: 0 },
      { name: 'B', atAgeDays: 42, kind: 'vaccine' },
      { name: 'W', atAgeDays: 14, kind: 'worming' },
    ]);
    expect(rows).toEqual([
      { name: 'A', kind: 'vaccine', dueOn: '2026-01-01' },
      { name: 'B', kind: 'vaccine', dueOn: '2026-02-12' },
      { name: 'W', kind: 'worming', dueOn: '2026-01-15' },
    ]);
  });
  it('returns nothing for a bad date', () => {
    expect(scheduleFromProtocol('not-a-date', DEFAULT_PROTOCOL)).toEqual([]);
  });
});

describe('recordStatus', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  it('classifies by given/due', () => {
    expect(recordStatus({ given_on: '2026-05-01', due_on: '2026-04-01' }, now)).toBe('done');
    expect(recordStatus({ given_on: null, due_on: '2026-05-01' }, now)).toBe('overdue');
    expect(recordStatus({ given_on: null, due_on: '2026-06-05' }, now)).toBe('due');
    expect(recordStatus({ given_on: null, due_on: '2026-08-01' }, now)).toBe('upcoming');
    expect(recordStatus({ given_on: null, due_on: null }, now)).toBe('upcoming');
  });
});

beforeAll(async () => {
  await db.exec(`
    CREATE TABLE users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email VARCHAR(255), role VARCHAR(20), kennel_id VARCHAR(255));
    CREATE TABLE devices (device_id VARCHAR(255) PRIMARY KEY, kennel_id VARCHAR(255));
  `);
  await db.exec(BREEDER_DDL);
  await db.exec(`
    CREATE TABLE vaccination_protocols (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), kennel_id VARCHAR(255) NOT NULL,
      name VARCHAR(255) NOT NULL, species VARCHAR(32) DEFAULT 'dog',
      doses JSONB NOT NULL DEFAULT '[]'::jsonb, is_default BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE vaccination_records (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), kennel_id VARCHAR(255) NOT NULL,
      animal_id UUID, puppy_id UUID, protocol_id UUID,
      name VARCHAR(255) NOT NULL, kind VARCHAR(20) NOT NULL DEFAULT 'vaccine',
      due_on DATE, given_on DATE, batch_no VARCHAR(128), vet_name VARCHAR(255),
      certificate_url TEXT, notes TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
  `);
});

describe('vaccinationSweep', () => {
  it('raises one care-inbox item per subject with an overdue record', async () => {
    await db.query(
      `INSERT INTO animals (id, kennel_id, name) VALUES ('11111111-1111-1111-1111-111111111111','home','Willow')`,
    );
    await db.query(
      `INSERT INTO vaccination_records (kennel_id, animal_id, name, kind, due_on) VALUES
        ('home','11111111-1111-1111-1111-111111111111','DHP/L primary','vaccine', CURRENT_DATE - 10),
        ('home','11111111-1111-1111-1111-111111111111','Rabies','vaccine', CURRENT_DATE - 3),
        ('home','11111111-1111-1111-1111-111111111111','Future booster','vaccine', CURRENT_DATE + 30)`,
    );

    const r = await vaccinationSweep();
    expect(r.raised).toBe(1);

    const ex = (await db.query<{ kind: string; title: string; detail: string }>(
      `SELECT kind, title, detail FROM exceptions WHERE kind='vaccination-due'`,
    )).rows;
    expect(ex).toHaveLength(1);
    expect(ex[0].title).toContain('Willow');
    expect(ex[0].title).toContain('2 vaccinations overdue');
    expect(ex[0].detail).not.toContain('Future booster');

    // idempotent — dedup_key keeps it to one open item
    await vaccinationSweep();
    expect(
      (await db.query(`SELECT id FROM exceptions WHERE kind='vaccination-due'`)).rows,
    ).toHaveLength(1);
  });
});
