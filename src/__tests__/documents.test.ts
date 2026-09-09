/**
 * Phase 7 slice 1 — storage round-trip + pedigree tree.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPedigree, type PedigreeAnimal } from '../breeder/logic/pedigree.js';
import {
  renderTemplate, templateTokens, buildDoc, defaultTemplate, DEFAULT_TEMPLATES,
} from '../breeder/logic/docTemplates.js';

describe('buildPedigree', () => {
  const A = (id: string, name: string, sire?: string, dam?: string): PedigreeAnimal => ({
    id, name, sire_id: sire ?? null, dam_id: dam ?? null,
  });
  const byId = new Map(
    [
      A('p', 'Puppy', 's', 'd'),
      A('s', 'Sire', 'gs1', 'gd1'),
      A('d', 'Dam', 'gs2'), // gd2 unknown
      A('gs1', 'Grandsire 1'),
      A('gd1', 'Granddam 1'),
      A('gs2', 'Grandsire 2'),
    ].map((a) => [a.id, a]),
  );

  it('walks sire/dam to the requested depth', () => {
    const tree = buildPedigree('p', byId, 4)!;
    expect(tree.name).toBe('Puppy');
    expect(tree.sire?.name).toBe('Sire');
    expect(tree.dam?.name).toBe('Dam');
    expect(tree.sire?.sire?.name).toBe('Grandsire 1');
    expect(tree.dam?.dam).toBeNull(); // gd2 missing
  });

  it('stops at generations = 1', () => {
    const tree = buildPedigree('p', byId, 1)!;
    expect(tree.sire?.name).toBe('Sire');
    expect(tree.sire?.sire).toBeNull();
  });

  it('returns null for an unknown animal and survives a cycle', () => {
    expect(buildPedigree('nope', byId, 3)).toBeNull();
    const cyclic = new Map<string, PedigreeAnimal>([['x', A('x', 'X', 'x')]]);
    expect(buildPedigree('x', cyclic, 3)?.sire).toBeNull();
  });
});

describe('doc templates (slice 2)', () => {
  it('templateTokens lists unique placeholders', () => {
    expect(templateTokens('{{a}} then {{ b }} then {{a}}')).toEqual(['a', 'b']);
  });

  it('renderTemplate fills tokens and leaves no placeholders', () => {
    const out = renderTemplate('Hi {{buyer_name}}, {{puppy_name}} is {{price}}.', {
      buyer_name: 'Aoife', puppy_name: 'Willow', price: '1800 EUR',
    });
    expect(out).toBe('Hi Aoife, Willow is 1800 EUR.');
    expect(out).not.toMatch(/\{\{/);
  });

  it('renderTemplate throws listing every missing token', () => {
    expect(() => renderTemplate('{{a}} {{b}} {{c}}', { a: 'x' }))
      .toThrow(/missing token\(s\): b, c/);
    expect(() => renderTemplate('{{a}}', { a: '' })).toThrow(/missing token/);
  });

  it('buildDoc merges caller tokens over auto and carries the kind', () => {
    const tpl = defaultTemplate('deposit-receipt')!;
    const doc = buildDoc(
      tpl,
      { today: '2026-09-09', kennel_name: 'Rathmore', buyer_name: 'Auto', breed: 'Golden Retriever', puppy_name: 'Willow' },
      { buyer_name: 'Caller wins', deposit: '300 EUR', balance: '1500 EUR' },
    );
    expect(doc.kind).toBe('receipt');
    expect(doc.body).toContain('From: Caller wins');
    expect(doc.body).toContain('deposit of 300 EUR');
    expect(doc.body).not.toContain('{{');
  });

  it('no template ships an em-dash', () => {
    for (const t of DEFAULT_TEMPLATES) expect(t.body).not.toMatch(/[—–]/);
  });
});

describe('LocalStorage', () => {
  let dir: string;
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('puts, gets and removes a file under the root', async () => {
    dir = await mkdtemp(join(tmpdir(), 'sp-storage-'));
    process.env.STORAGE_DRIVER = 'local';
    process.env.STORAGE_DIR = dir;
    const { getStorage, _resetStorage } = await import('../services/storage.js');
    _resetStorage();
    const s = getStorage();

    const key = 'home/abc-cert.pdf';
    await s.put(key, Buffer.from('hello pdf'), 'application/pdf');
    expect((await s.get(key)).toString()).toBe('hello pdf');
    expect(await readdir(join(dir, 'home'))).toContain('abc-cert.pdf');

    await s.remove(key);
    await expect(s.get(key)).rejects.toThrow();
  });

  it('rejects a key that escapes the root', async () => {
    const { getStorage } = await import('../services/storage.js');
    await expect(getStorage().put('../../etc/x', Buffer.from('x'))).rejects.toThrow(/escapes/);
  });
});
