/**
 * Phase 8 slice 2 — retention sweep + GDPR export / delete.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { BREEDER_DDL } from '../breeder/schema.js';

const db = new PGlite();
vi.mock('../database/index.js', () => ({
  query: async (t: string, p?: unknown[]) => (await db.query(t, p as unknown[])).rows,
  queryOne: async (t: string, p?: unknown[]) => (await db.query(t, p as unknown[])).rows[0] ?? null,
  execute: async (t: string, p?: unknown[]) => {
    await db.query(t, p as unknown[]);
  },
  pool: {},
}));

const { default: privacyRouter, retentionSweep } = await import('../breeder/routes/privacy.js');

const M = dirname(fileURLToPath(import.meta.url)).replace(/__tests__$/, 'database/migrations');
const mig = (f: string) => readFileSync(join(M, f), 'utf8');

let base: string;

beforeAll(async () => {
  await db.exec(`
    CREATE TABLE users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email VARCHAR(255), role VARCHAR(20), kennel_id VARCHAR(255));
    CREATE TABLE devices (device_id VARCHAR(255) PRIMARY KEY, kennel_id VARCHAR(255));
  `);
  await db.exec(BREEDER_DDL);
  for (const f of [
    '004_vaccinations.sql',
    '005_buyer_comms.sql',
    '006_breeding_calendar.sql', // gitleaks:allow — migration filenames, not a key
    '007_documents.sql',
    '009_access_log.sql',
    '010_retention.sql', // gitleaks:allow
    '015_partition_access_log.sql',
    '016_partition_exceptions.sql',
  ]) {
    // gitleaks:allow
    await db.exec(mig(f));
  }

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { kennelId: string }).kennelId = 'home';
    (req as unknown as { user: { id: string } }).user = {
      id: '00000000-0000-0000-0000-0000000000aa',
    };
    next();
  });
  app.use(privacyRouter);
  const srv = await new Promise<import('node:http').Server>((r) => {
    const s = app.listen(0, () => r(s));
  });
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});

describe('retentionSweep', () => {
  it('purges access_log and documents past their window, keeps the rest', async () => {
    await db.query(
      `INSERT INTO access_log (kennel_id, action, at) VALUES
       ('home','document.download', NOW() - INTERVAL '400 days'),
       ('home','document.download', NOW() - INTERVAL '10 days'),
       ('other','document.download', NOW() - INTERVAL '400 days')`,
    );
    await db.query(
      `INSERT INTO documents (kennel_id, kind, title, body, created_at) VALUES
       ('home','contract','old', 'x', NOW() - INTERVAL '400 days'),
       ('home','contract','new', 'x', NOW() - INTERVAL '5 days')`,
    );
    await db.query(
      `INSERT INTO retention_settings (kennel_id, data_class, keep_days) VALUES
       ('home','access_log', 90), ('home','document', 365)`,
    );

    const r = await retentionSweep();
    expect(r).toEqual({ accessLog: 1, documents: 1, exceptions: 0 });

    // untouched: recent home rows + the other kennel has no policy
    expect((await db.query(`SELECT id FROM access_log`)).rows).toHaveLength(2);
    expect((await db.query(`SELECT title FROM documents`)).rows).toEqual([{ title: 'new' }]);

    // idempotent
    expect(await retentionSweep()).toEqual({ accessLog: 0, documents: 0, exceptions: 0 });
  });
});

describe('GDPR export', () => {
  it('bundles a buyer with their messages and documents', async () => {
    await db.query(`INSERT INTO buyers (id, kennel_id, name, email) VALUES
      ('b1111111-1111-1111-1111-111111111111','home','Aoife M.','aoife@example.com')`);
    await db.query(`INSERT INTO buyer_messages (kennel_id, buyer_id, kind, subject, body) VALUES
      ('home','b1111111-1111-1111-1111-111111111111','direct','Hi','hello')`);
    await db.query(`INSERT INTO documents (kennel_id, kind, subject_type, subject_id, title, body) VALUES
      ('home','contract','buyer','b1111111-1111-1111-1111-111111111111','Sale', 'x')`);

    const res = await fetch(
      `${base}/export?subjectType=buyer&id=b1111111-1111-1111-1111-111111111111`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.buyer.email).toBe('aoife@example.com');
    expect(body.messages).toHaveLength(1);
    expect(body.documents).toHaveLength(1);

    // and it recorded the export
    expect(
      (await db.query(`SELECT action FROM access_log WHERE action = 'privacy.export'`)).rows,
    ).toHaveLength(1);
  });

  it('rejects an unknown subject type', async () => {
    const res = await fetch(`${base}/export?subjectType=owner&id=x`);
    expect(res.status).toBe(400);
  });
});

describe('GDPR delete', () => {
  it('needs confirm:true', async () => {
    const res = await fetch(`${base}/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subjectType: 'buyer', id: 'b1111111-1111-1111-1111-111111111111' }),
    });
    expect(res.status).toBe(400);
  });

  it('erases a buyer, detaches their puppies, cascades their messages', async () => {
    await db.query(`INSERT INTO litters (id, kennel_id, name) VALUES
      ('c1111111-1111-1111-1111-111111111111','home','L1')`);
    await db.query(`INSERT INTO puppies (id, kennel_id, litter_id, name, buyer_id, status) VALUES
      ('d1111111-1111-1111-1111-111111111111','home','c1111111-1111-1111-1111-111111111111','Green',
       'b1111111-1111-1111-1111-111111111111','sold')`);

    const res = await fetch(`${base}/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subjectType: 'buyer',
        id: 'b1111111-1111-1111-1111-111111111111',
        confirm: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted.buyers).toBe(1);

    expect(
      (await db.query(`SELECT id FROM buyers WHERE id = 'b1111111-1111-1111-1111-111111111111'`))
        .rows,
    ).toHaveLength(0);
    expect(
      (
        await db.query(
          `SELECT id FROM buyer_messages WHERE buyer_id = 'b1111111-1111-1111-1111-111111111111'`,
        )
      ).rows,
    ).toHaveLength(0);
    const pup = (
      await db.query<{ buyer_id: string | null }>(
        `SELECT buyer_id FROM puppies WHERE id = 'd1111111-1111-1111-1111-111111111111'`,
      )
    ).rows[0];
    expect(pup.buyer_id).toBeNull(); // puppy kept, just detached
  });

  it('refuses to erase an animal that is a litter parent', async () => {
    await db.query(`INSERT INTO animals (id, kennel_id, name) VALUES
      ('a1111111-1111-1111-1111-111111111111','home','Willow')`);
    await db.query(`UPDATE litters SET dam_id = 'a1111111-1111-1111-1111-111111111111'
      WHERE id = 'c1111111-1111-1111-1111-111111111111'`);

    const res = await fetch(`${base}/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subjectType: 'animal',
        id: 'a1111111-1111-1111-1111-111111111111',
        confirm: true,
      }),
    });
    expect(res.status).toBe(409);
    expect(
      (await db.query(`SELECT id FROM animals WHERE id = 'a1111111-1111-1111-1111-111111111111'`))
        .rows,
    ).toHaveLength(1);
  });
});
