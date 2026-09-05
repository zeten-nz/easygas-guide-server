import crypto from 'node:crypto';

/**
 * Phase 10D deterministic canonical serialization for completion digests.
 *
 * JSON.stringify does NOT guarantee key ordering across shapes, so it must not
 * be used for a hashed artifact. This produces a stable string: object keys are
 * sorted recursively; arrays keep their given order (callers order them
 * explicitly); numbers/booleans/strings/null are emitted deterministically;
 * `undefined` is omitted. No timestamps are generated here — the caller passes
 * only stable, already-computed data, so recomputing the digest of the same
 * content always yields the same result.
 */
export function canonicalStringify(value: unknown): string {
  return build(value);
}

function build(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return Number.isFinite(v) ? JSON.stringify(v) : 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return JSON.stringify(v);
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(build).join(',')}]`;
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${build(obj[k])}`).join(',')}}`;
  }
  return 'null';
}

export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Canonical digest of a value: sha256 over its canonical serialization. */
export function digestOf(value: unknown): string {
  return sha256Hex(canonicalStringify(value));
}
