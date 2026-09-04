import fs from 'node:fs/promises';
import path from 'node:path';
import type { StorageProvider } from './storage.provider';

/**
 * Local-filesystem provider for development. Files live under a configured
 * root directory; keys are resolved strictly inside it (path traversal in a
 * key throws). The directory is NEVER exposed statically — bytes are served
 * only through the authorized API endpoint.
 */
export class LocalStorageProvider implements StorageProvider {
  readonly name = 'local';
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = path.resolve(rootDir);
  }

  private resolveSafe(key: string): string {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) {
      throw new Error('Storage key escapes the storage root');
    }
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const full = this.resolveSafe(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, data);
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFile(this.resolveSafe(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolveSafe(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(this.resolveSafe(key));
    } catch {
      /* best-effort */
    }
  }
}
