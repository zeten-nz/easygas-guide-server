import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { StorageError, type ObjectStat, type PutOptions, type StorageProvider } from './storage.provider';

/**
 * Local-filesystem provider for development and tests. Files live under a
 * configured root directory; keys are resolved strictly inside it (path
 * traversal throws StorageError('INVALID_KEY')). The directory is NEVER
 * exposed statically — bytes are served only through the authorized API.
 */
export class LocalStorageProvider implements StorageProvider {
  readonly name = 'local';
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = path.resolve(rootDir);
  }

  private resolveSafe(key: string): string {
    if (typeof key !== 'string' || key.length === 0 || path.isAbsolute(key)) {
      throw new StorageError('INVALID_KEY', 'Invalid storage key');
    }
    const full = path.resolve(this.root, key);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new StorageError('INVALID_KEY', 'Storage key escapes the storage root');
    }
    return full;
  }

  async put(key: string, data: Buffer, _options?: PutOptions): Promise<ObjectStat> {
    const full = this.resolveSafe(key);
    try {
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, data);
    } catch (err) {
      throw new StorageError('IO', 'Local write failed', err);
    }
    const stat = await this.stat(key);
    if (!stat) throw new StorageError('IO', 'Object missing immediately after write');
    return stat;
  }

  async getStream(key: string): Promise<Readable> {
    const full = this.resolveSafe(key);
    if (!(await this.exists(key))) throw new StorageError('NOT_FOUND', 'Object not found');
    return createReadStream(full);
  }

  async stat(key: string): Promise<ObjectStat | null> {
    const full = this.resolveSafe(key);
    try {
      const s = await fs.stat(full);
      if (!s.isFile()) return null;
      return { size: s.size, contentType: null, checksum: null };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new StorageError('IO', 'Local stat failed', err);
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.stat(key)) !== null;
  }

  async delete(key: string): Promise<void> {
    const full = this.resolveSafe(key);
    try {
      await fs.unlink(full);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new StorageError('IO', 'Local delete failed', err);
      }
    }
  }
}
