/**
 * File storage behind one interface. `local` writes to STORAGE_DIR now;
 * an S3 driver slots in here for Phase 10 without touching callers.
 */
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

export interface Storage {
  driver: string;
  put(key: string, data: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

class LocalStorage implements Storage {
  driver = 'local';
  private root: string;
  constructor(dir: string) {
    this.root = resolve(dir);
  }
  private path(key: string): string {
    const p = resolve(this.root, key);
    if (p !== this.root && !p.startsWith(this.root + sep)) {
      throw new Error('storage key escapes the root');
    }
    return p;
  }
  async put(key: string, data: Buffer): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
  }
  async get(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }
  async remove(key: string): Promise<void> {
    await unlink(this.path(key)).catch(() => undefined);
  }
}

let instance: Storage | null = null;

export function getStorage(): Storage {
  if (instance) return instance;
  const driver = process.env.STORAGE_DRIVER ?? 'local';
  if (driver !== 'local' && driver !== 'disk') {
    console.warn(`[storage] driver "${driver}" not implemented yet — using local`);
  }
  instance = new LocalStorage(process.env.STORAGE_DIR ?? './data/uploads');
  return instance;
}

/** Tests only. */
export function _resetStorage(): void {
  instance = null;
}
