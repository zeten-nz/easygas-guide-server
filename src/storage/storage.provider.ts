import type { Readable } from 'node:stream';

/**
 * Object-storage abstraction (loyiha.md §19/§40, Phase 10B).
 *
 * Business logic depends only on this interface, never on provider-specific
 * (e.g. AWS) types. Keys are ALWAYS server-generated relative paths — never
 * client input — and every implementation must reject path traversal.
 *
 * `put` returns the object's verified metadata so the caller can confirm the
 * write before marking evidence READY. `stat` is the HEAD/existence check used
 * by completion gates and reconciliation.
 */
export interface ObjectStat {
  /** Byte size of the stored object. */
  size: number;
  /** Content type when the store records one (S3), else null (local). */
  contentType: string | null;
  /** Provider checksum/ETag when available (advisory — not a substitute for our sha256). */
  checksum: string | null;
}

export interface PutOptions {
  contentType?: string;
  /** Our sha256 (hex) — stored as object metadata where the provider supports it. */
  sha256?: string;
}

export interface StorageProvider {
  readonly name: string;
  /** Writes bytes and returns the stored object's verified metadata. */
  put(key: string, data: Buffer, options?: PutOptions): Promise<ObjectStat>;
  /** Reads the object as a stream (callers pipe to the HTTP response). */
  getStream(key: string): Promise<Readable>;
  /** HEAD/stat: metadata if the object exists, else null. Never throws for "missing". */
  stat(key: string): Promise<ObjectStat | null>;
  exists(key: string): Promise<boolean>;
  /** Best-effort delete; never throws for "missing". */
  delete(key: string): Promise<void>;
}

/**
 * Normalized storage error. Providers translate their native errors into this
 * so the rest of the app never sees AWS/fs specifics, and error middleware can
 * respond without leaking provider messages.
 */
export type StorageErrorKind = 'NOT_FOUND' | 'TIMEOUT' | 'ACCESS_DENIED' | 'INVALID_KEY' | 'IO';

export class StorageError extends Error {
  readonly kind: StorageErrorKind;
  constructor(kind: StorageErrorKind, message: string, cause?: unknown) {
    super(message);
    this.name = 'StorageError';
    this.kind = kind;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}
