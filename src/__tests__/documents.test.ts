/**
 * Phase 7 slice 1 — storage round-trip + pedigree tree.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPedigree, type PedigreeAnimal } from '../breeder/logic/pedigree.js';

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
