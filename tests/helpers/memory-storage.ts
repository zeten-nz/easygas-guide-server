import { Readable } from 'node:stream';
import { StorageError, type ObjectStat, type PutOptions, type StorageProvider } from '../../src/storage/storage.provider';

/**
 * Controllable in-memory storage provider for tests. Beyond the normal
 * behavior it can inject failures/latency at chosen points so the two-phase
 * upload state machine can be exercised deterministically (no sleeps):
 *
 *   failNextPut       — the next put() throws (storage write failure)
 *   putBarrier        — a promise put() awaits before writing (ordering control)
 *   afterPut          — hook run after a successful write (e.g. mutate DB state
 *                       to simulate the workflow moving on during upload)
 *   statOverride       — force a stat() result (size mismatch / missing / timeout)
 */
export class MemoryStorageProvider implements StorageProvider {
  readonly name = 'local'; // pose as 'local' so production guards stay happy in tests
  private readonly objects = new Map<string, { data: Buffer; contentType?: string }>();

  failNextPut: StorageError | null = null;
  putBarrier: Promise<void> | null = null;
  /** Fired when put() is entered (i.e. TX1 committed) — before the barrier. */
  onPutEnter: (() => void) | null = null;
  afterPut: ((key: string) => Promise<void>) | null = null;
  statOverride: Map<string, ObjectStat | 'MISSING' | StorageError> = new Map();
  /** Per-key transient failure for getStream (e.g. a TIMEOUT during a deep read). */
  getStreamOverride: Map<string, StorageError> = new Map();

  private assertKey(key: string): void {
    if (typeof key !== 'string' || key.length === 0 || key.startsWith('/') || key.includes('..')) {
      throw new StorageError('INVALID_KEY', 'Invalid storage key');
    }
  }

  async put(key: string, data: Buffer, options?: PutOptions): Promise<ObjectStat> {
    this.assertKey(key);
    if (this.onPutEnter) {
      const cb = this.onPutEnter;
      this.onPutEnter = null;
      cb();
    }
    if (this.putBarrier) await this.putBarrier;
    if (this.failNextPut) {
      const err = this.failNextPut;
      this.failNextPut = null;
      throw err;
    }
    this.objects.set(key, { data: Buffer.from(data), contentType: options?.contentType });
    if (this.afterPut) await this.afterPut(key);
    // Re-stat after the write (like the real providers) so a post-write
    // mutation via afterPut/statOverride is reflected in the returned metadata.
    const stat = await this.stat(key);
    if (!stat) throw new StorageError('IO', 'Object missing immediately after write');
    return stat;
  }

  async getStream(key: string): Promise<Readable> {
    this.assertKey(key);
    const override = this.getStreamOverride.get(key);
    if (override) throw override;
    const obj = this.objects.get(key);
    if (!obj) throw new StorageError('NOT_FOUND', 'Object not found');
    return Readable.from(obj.data);
  }

  async stat(key: string): Promise<ObjectStat | null> {
    this.assertKey(key);
    const override = this.statOverride.get(key);
    if (override === 'MISSING') return null;
    if (override instanceof StorageError) throw override;
    if (override) return override;
    const obj = this.objects.get(key);
    return obj ? { size: obj.data.length, contentType: obj.contentType ?? null, checksum: null } : null;
  }

  async exists(key: string): Promise<boolean> {
    return (await this.stat(key)) !== null;
  }

  async delete(key: string): Promise<void> {
    this.assertKey(key);
    this.objects.delete(key);
  }

  // Test introspection / setup
  /** Places raw bytes directly (bypassing put hooks) — simulates a legacy or
   *  externally-modified object. */
  setObject(key: string, data: Buffer, contentType?: string): void {
    this.objects.set(key, { data: Buffer.from(data), contentType });
  }
  has(key: string): boolean {
    return this.objects.has(key);
  }
  get size(): number {
    return this.objects.size;
  }
  raw(key: string): Buffer | undefined {
    return this.objects.get(key)?.data;
  }
}
