/**
 * Runs the real breeder DDL against an ephemeral in-process Postgres (pglite)
 * so schema typos and constraint mistakes fail here, not on a live boot.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { BREEDER_DDL } from '../breeder/schema.js';

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  // Minimal prerequisite tables the DDL expects to already exist.
  await db.exec(`
    CREATE TABLE users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email VARCHAR(255) UNIQUE NOT NULL,
      role VARCHAR(20) DEFAULT 'owner'
    );
    CREATE TABLE devices (
      device_id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255),
      device_type VARCHAR(50),
      kennel_id VARCHAR(255),
      status VARCHAR(20),
      is_online BOOLEAN,
      last_seen TIMESTAMPTZ
    );
  `);
});

afterAll(async () => { await db.close(); });

describe('breeder DDL', () => {
  it('applies cleanly and is idempotent', async () => {
    await db.exec(BREEDER_DDL);
    await db.exec(BREEDER_DDL); // second run must not error
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`
    );
    const names = rows.map((r) => r.table_name);
    for (const t of [
      'kennels', 'pens', 'animals', 'care_plans', 'medications', 'medication_logs',
      'litters', 'puppies', 'buyers', 'weight_readings', 'intake_events', 'consumables',
      'rules', 'rule_firings', 'exceptions', 'notifications', 'notification_prefs',
      'device_health_counters', 'enrichment_sessions', 'emergency_events', 'offline_journal',
    ]) {
      expect(names).toContain(t);
    }
  });

  it('adds users.kennel_id', async () => {
    const { rows } = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name='kennel_id'`
    );
    expect(rows).toHaveLength(1);
  });

  it('care_plans upsert on animal_id works', async () => {
    const u = await db.query<{ id: string }>(`INSERT INTO users (email) VALUES ('b@x.io') RETURNING id`);
    const userId = u.rows[0].id;
    await db.query(`INSERT INTO kennels (slug, name, owner_user_id) VALUES ('home','Home',$1)`, [userId]);
    const a = await db.query<{ id: string }>(
      `INSERT INTO animals (kennel_id, name, sex, adult_weight_kg) VALUES ('home','Bella','female',28) RETURNING id`
    );
    const animalId = a.rows[0].id;

    await db.query(
      `INSERT INTO care_plans (animal_id, kennel_id, grams_per_day) VALUES ($1,'home',300)`, [animalId]
    );
    await db.query(
      `INSERT INTO care_plans (animal_id, kennel_id, grams_per_day) VALUES ($1,'home',350)
       ON CONFLICT (animal_id) DO UPDATE SET grams_per_day = EXCLUDED.grams_per_day`,
      [animalId]
    );
    const cp = await db.query<{ grams_per_day: number }>(
      `SELECT grams_per_day FROM care_plans WHERE animal_id = $1`, [animalId]
    );
    expect(Number(cp.rows[0].grams_per_day)).toBe(350);
  });

  it('exception dedup index + partial WHERE holds', async () => {
    await db.query(
      `INSERT INTO exceptions (kennel_id, kind, severity, title, dedup_key, first_notified_at)
       VALUES ('home','temp-high','critical','hot','temp-high:sensor-1', NOW())`
    );
    const open = await db.query(
      `SELECT id FROM exceptions
        WHERE kennel_id='home' AND dedup_key='temp-high:sensor-1' AND status IN ('open','snoozed','escalated')`
    );
    expect(open.rows).toHaveLength(1);

    // resolve it, then the same dedup key is free again
    await db.query(`UPDATE exceptions SET status='resolved' WHERE dedup_key='temp-high:sensor-1'`);
    const stillOpen = await db.query(
      `SELECT id FROM exceptions
        WHERE kennel_id='home' AND dedup_key='temp-high:sensor-1' AND status IN ('open','snoozed','escalated')`
    );
    expect(stillOpen.rows).toHaveLength(0);
  });

  it('rules store + read JSONB trigger/actions', async () => {
    await db.query(
      `INSERT INTO rules (kennel_id, name, trigger, conditions, actions)
       VALUES ('home','r', $1, $2, $3)`,
      [
        JSON.stringify({ type: 'telemetry', metric: 'temperature' }),
        JSON.stringify([{ field: 'value', op: 'gt', value: 28 }]),
        JSON.stringify([{ type: 'raise_exception', kind: 'temp-high' }]),
      ]
    );
    const r = await db.query<{ trigger: any; actions: any }>(`SELECT trigger, actions FROM rules WHERE name='r'`);
    expect(r.rows[0].trigger.metric).toBe('temperature');
    expect(r.rows[0].actions[0].kind).toBe('temp-high');
  });

  it('weight_readings CHECK requires a subject', async () => {
    await expect(
      db.query(`INSERT INTO weight_readings (kennel_id, grams) VALUES ('home', 500)`)
    ).rejects.toThrow();
  });
});
