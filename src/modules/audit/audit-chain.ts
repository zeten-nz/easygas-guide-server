import { createHash } from 'node:crypto';

/**
 * Phase 10F — tamper-evident audit chain (pure helpers).
 *
 * Each new audit row is linked to the previous row IN ITS CHAIN via
 * `prev_hash`, and carries its own `entry_hash` computed over a DETERMINISTIC
 * canonical serialization of its material fields plus `prev_hash` and
 * `chain_seq`. Any change to a row's content, or a deletion/reordering that
 * breaks the seq/prev_hash links, is detectable by re-deriving the hashes.
 *
 * Chain SCOPE is per-UTC-day (`chain_id` = 'YYYY-MM-DD'): a bounded partition so
 * verification pages per day and concurrent writers only serialize within the
 * current day (not across the whole application). Numeric ordering is carried by
 * `chain_seq` (monotonic within a chain); `created_at` is informational and is
 * intentionally NOT part of the hash (its precision was upgraded separately).
 *
 * The chain payload contains only fields already stored on the row; no raw
 * signature, OTP, token, GPS coordinate or secret is introduced here (the
 * serializer hashes whatever the row holds — coordinates/signatures are never in
 * audit payloads by design; see gps/completion services).
 */

export const CHAIN_VERSION = 'v1';

/** Deterministic serialization: object keys sorted, stable across the round-trip
 *  through MySQL JSON storage (which may reorder keys). */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

export interface ChainFields {
  chainId: string;
  chainSeq: number;
  prevHash: string;
  userId: number | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  oldValue: unknown; // parsed object / null
  newValue: unknown; // parsed object / null
  ip: string | null;
  userAgent: string | null;
}

/** The exact string that is hashed for an entry (write- and verify-time identical). */
export function buildCanonical(f: ChainFields): string {
  return canonicalize({
    v: CHAIN_VERSION,
    chainId: f.chainId,
    chainSeq: f.chainSeq,
    prevHash: f.prevHash,
    userId: f.userId ?? null,
    action: f.action,
    entityType: f.entityType ?? null,
    entityId: f.entityId ?? null,
    oldValue: f.oldValue ?? null,
    newValue: f.newValue ?? null,
    ip: f.ip ?? null,
    userAgent: f.userAgent ?? null,
  });
}

function sha256hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export function computeEntryHash(f: ChainFields): string {
  return sha256hex(buildCanonical(f));
}

/** The per-chain genesis link (prev_hash of the first entry in a day's chain). */
export function genesisHash(chainId: string): string {
  return sha256hex(`easygas-audit-chain-genesis|${CHAIN_VERSION}|${chainId}`);
}

/** UTC 'YYYY-MM-DD' chain id for a moment. */
export function utcChainId(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}
