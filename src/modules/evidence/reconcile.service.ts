import crypto from 'node:crypto';
import { db } from '../../config/database';
import { logAudit } from '../audit/audit.service';
import { getStorageProvider } from '../../storage';
import { StorageError, type StorageProvider } from '../../storage/storage.provider';
import { inspectImage } from '../../utils/image';

/**
 * Phase 10B evidence reconciliation.
 *
 * Compares database evidence metadata against the object store. DRY-RUN BY
 * DEFAULT — it reports only and never deletes objects. With `apply` it
 * transitions rows but STILL never deletes objects.
 *
 * Three passes per table:
 *
 *  1. LEGACY (status = UNVERIFIED) — pre-Phase-10B rows whose object was never
 *     verified. Always DEEP: the object is read in full, its sha256 recomputed
 *     and compared with the recorded size + hash (+ detected image type). Only
 *     a full match promotes UNVERIFIED -> READY (audited EVIDENCE_VERIFIED). A
 *     missing/short/altered object becomes FAILED (audited
 *     EVIDENCE_INTEGRITY_FAILURE). A DB row is never trusted as READY merely
 *     because it exists.
 *
 *  2. READY integrity — existing READY rows are re-checked. Size + existence by
 *     default; with `deep`, the full sha256 is re-verified too. A missing or
 *     mismatched object becomes FAILED (it stops counting toward completion).
 *
 *  3. STALE PENDING — a PENDING upload older than the staleness window (an
 *     interrupted Phase 10B upload) becomes FAILED(STALE). UNVERIFIED legacy
 *     rows are NEVER touched by this sweep.
 *
 * Idempotent + resumable: every transition runs in its own transaction and only
 * fires when the row is still in the expected source state, so an interrupted
 * run can simply be run again, and re-running a completed run changes nothing.
 * Bounded concurrency limits how many objects are read at once. A transient
 * storage error leaves the row untouched (ERROR) so a later run can retry it.
 * Audit records never contain storage keys, filesystem paths or provider
 * messages.
 */

type EvidenceTable = 'job_photos' | 'customer_signatures';

export type RecordKind = 'VERIFIED' | 'OK' | 'MISSING' | 'MISMATCH' | 'STALE' | 'ERROR';

export interface RecordResult {
  table: EvidenceTable;
  id: number;
  jobId: number;
  kind: RecordKind;
  /** Sanitized reason — never a storage key, path or raw provider message. */
  reason: string;
  transitionedTo: 'READY' | 'FAILED' | null;
}

export interface ReconcileOptions {
  /** Apply transitions (mutate). */
  apply?: boolean;
  /** Backward-compatible alias for {@link ReconcileOptions.apply}. */
  fix?: boolean;
  /** Also re-hash READY rows (legacy UNVERIFIED rows are always deep-verified). */
  deep?: boolean;
  /** Max objects read in parallel (default 4). */
  concurrency?: number;
}

export interface ReconcileResult {
  scanned: number;
  results: RecordResult[];
  /** Records that are not clean (MISSING/MISMATCH/STALE/ERROR). */
  findings: RecordResult[];
  /** Legacy rows promoted UNVERIFIED -> READY this run. */
  verified: number;
  /** Rows transitioned to FAILED this run. */
  failed: number;
  /** Total rows transitioned this run (verified + failed). */
  fixed: number;
  /** Invalid or unverifiable rows remaining — drives the CLI exit code. */
  unresolved: number;
  dryRun: boolean;
  deep: boolean;
}

const STALE_PENDING_MS = 15 * 60 * 1000; // an upload older than 15 min is abandoned

/** Runs `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  const n = Math.min(Math.max(1, limit), items.length || 1);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

/** Reads the whole object and returns its size + sha256, or null if absent. Rethrows transient errors. */
async function readAndHash(
  storage: StorageProvider,
  key: string,
): Promise<{ size: number; sha256: string; bytes: Buffer } | null> {
  let stream: import('node:stream').Readable;
  try {
    stream = await storage.getStream(key);
  } catch (err) {
    if (err instanceof StorageError && err.kind === 'NOT_FOUND') return null;
    throw err; // transient (TIMEOUT/IO/ACCESS_DENIED) — caller records ERROR
  }
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  const bytes = Buffer.concat(chunks);
  return { size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes };
}

/** Transitions a row FROM an expected status to READY (legacy promotion). Idempotent. */
async function promoteReady(table: EvidenceTable, id: number, jobId: number): Promise<'READY' | null> {
  return db.transaction(async (trx) => {
    const row = await trx(table).where({ id, status: 'UNVERIFIED' }).forUpdate().first();
    if (!row) return null; // already handled by a previous/concurrent run — idempotent
    await trx(table).where({ id }).update({ status: 'READY', ready_at: trx.fn.now() });
    await logAudit(
      {
        userId: null,
        action: 'EVIDENCE_VERIFIED',
        entityType: table === 'job_photos' ? 'job_photo' : 'job',
        entityId: table === 'job_photos' ? id : jobId,
        oldValue: { status: 'UNVERIFIED' },
        newValue: { table, id, verifiedBy: 'reconcile-deep' },
        ip: null,
        userAgent: 'reconcile',
      },
      trx,
    );
    return 'READY';
  });
}

/** Transitions a row FROM an expected status to FAILED + audits it. Idempotent. */
async function failFrom(
  table: EvidenceTable,
  id: number,
  jobId: number,
  fromStatus: 'READY' | 'UNVERIFIED' | 'PENDING',
  reason: string,
): Promise<'FAILED' | null> {
  return db.transaction(async (trx) => {
    const row = await trx(table).where({ id, status: fromStatus }).forUpdate().first();
    if (!row) return null; // already handled — idempotent
    await trx(table).where({ id }).update({ status: 'FAILED', failed_at: trx.fn.now(), failure_reason: reason });
    await logAudit(
      {
        userId: null,
        action: 'EVIDENCE_INTEGRITY_FAILURE',
        entityType: table === 'job_photos' ? 'job_photo' : 'job',
        entityId: table === 'job_photos' ? id : jobId,
        oldValue: { status: fromStatus },
        newValue: { table, id, reason },
        ip: null,
        userAgent: 'reconcile',
      },
      trx,
    );
    return 'FAILED';
  });
}

type LegacyRow = { id: number; job_id: number; storage_key: string; size_bytes: number; hash: string | null; mime_type: string | null };

/** Deep-verifies one legacy (UNVERIFIED) row against storage. */
async function verifyLegacy(
  storage: StorageProvider,
  table: EvidenceTable,
  row: LegacyRow,
  apply: boolean,
): Promise<RecordResult> {
  const base = { table, id: row.id, jobId: row.job_id };
  let read: Awaited<ReturnType<typeof readAndHash>>;
  try {
    read = await readAndHash(storage, row.storage_key);
  } catch (err) {
    // Transient: leave the row UNVERIFIED so a later run retries it (resumable).
    return { ...base, kind: 'ERROR', reason: `storage ${err instanceof StorageError ? err.kind : 'error'}`, transitionedTo: null };
  }
  if (read === null) {
    const t = apply ? await failFrom(table, row.id, row.job_id, 'UNVERIFIED', 'LEGACY_MISSING') : null;
    return { ...base, kind: 'MISSING', reason: 'object absent', transitionedTo: t };
  }
  if (read.size !== row.size_bytes) {
    const t = apply ? await failFrom(table, row.id, row.job_id, 'UNVERIFIED', 'LEGACY_SIZE_MISMATCH') : null;
    return { ...base, kind: 'MISMATCH', reason: 'stored size differs from metadata', transitionedTo: t };
  }
  if (row.hash && read.sha256 !== row.hash) {
    const t = apply ? await failFrom(table, row.id, row.job_id, 'UNVERIFIED', 'LEGACY_HASH_MISMATCH') : null;
    return { ...base, kind: 'MISMATCH', reason: 'sha256 differs from metadata', transitionedTo: t };
  }
  // Detected content type (from the actual bytes) must be an acceptable image
  // and agree with the recorded type where one exists.
  const img = inspectImage(read.bytes);
  const detected = 'mime' in img ? img.mime : null;
  if (!detected || (row.mime_type && detected !== row.mime_type)) {
    const t = apply ? await failFrom(table, row.id, row.job_id, 'UNVERIFIED', 'LEGACY_CONTENT_TYPE') : null;
    return { ...base, kind: 'MISMATCH', reason: 'content type not an acceptable image', transitionedTo: t };
  }
  const t = apply ? await promoteReady(table, row.id, row.job_id) : null;
  return { ...base, kind: 'VERIFIED', reason: 'object matches metadata', transitionedTo: t };
}

type ReadyRow = { id: number; job_id: number; storage_key: string; size_bytes: number; hash: string | null };

/** Re-checks one READY row: size (+existence) always; sha256 when `deep`. */
async function verifyReady(
  storage: StorageProvider,
  table: EvidenceTable,
  row: ReadyRow,
  apply: boolean,
  deep: boolean,
): Promise<RecordResult> {
  const base = { table, id: row.id, jobId: row.job_id };
  if (deep) {
    let read: Awaited<ReturnType<typeof readAndHash>>;
    try {
      read = await readAndHash(storage, row.storage_key);
    } catch (err) {
      return { ...base, kind: 'ERROR', reason: `storage ${err instanceof StorageError ? err.kind : 'error'}`, transitionedTo: null };
    }
    if (read === null) {
      const t = apply ? await failFrom(table, row.id, row.job_id, 'READY', 'MISSING_OBJECT') : null;
      return { ...base, kind: 'MISSING', reason: 'object absent', transitionedTo: t };
    }
    if (read.size !== row.size_bytes) {
      const t = apply ? await failFrom(table, row.id, row.job_id, 'READY', 'SIZE_MISMATCH') : null;
      return { ...base, kind: 'MISMATCH', reason: 'stored size differs from metadata', transitionedTo: t };
    }
    if (row.hash && read.sha256 !== row.hash) {
      const t = apply ? await failFrom(table, row.id, row.job_id, 'READY', 'HASH_MISMATCH') : null;
      return { ...base, kind: 'MISMATCH', reason: 'sha256 differs from metadata', transitionedTo: t };
    }
    return { ...base, kind: 'OK', reason: 'verified (deep)', transitionedTo: null };
  }
  let stat: Awaited<ReturnType<StorageProvider['stat']>>;
  try {
    stat = await storage.stat(row.storage_key);
  } catch (err) {
    return { ...base, kind: 'ERROR', reason: `storage ${err instanceof StorageError ? err.kind : 'error'}`, transitionedTo: null };
  }
  if (!stat) {
    const t = apply ? await failFrom(table, row.id, row.job_id, 'READY', 'MISSING_OBJECT') : null;
    return { ...base, kind: 'MISSING', reason: 'object absent', transitionedTo: t };
  }
  if (stat.size !== row.size_bytes) {
    const t = apply ? await failFrom(table, row.id, row.job_id, 'READY', 'SIZE_MISMATCH') : null;
    return { ...base, kind: 'MISMATCH', reason: 'stored size differs from metadata', transitionedTo: t };
  }
  return { ...base, kind: 'OK', reason: 'verified (size)', transitionedTo: null };
}

export async function reconcileEvidence(options: ReconcileOptions = {}): Promise<ReconcileResult> {
  const apply = options.apply ?? options.fix ?? false;
  const deep = options.deep ?? false;
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const storage = getStorageProvider();
  const results: RecordResult[] = [];

  for (const table of ['job_photos', 'customer_signatures'] as const) {
    // 1. Legacy UNVERIFIED — always deep (must read bytes to promote).
    const legacy = (await db(table)
      .where({ status: 'UNVERIFIED' })
      .select('id', 'job_id', 'storage_key', 'size_bytes', 'hash', 'mime_type')) as LegacyRow[];
    results.push(...(await mapPool(legacy, concurrency, (row) => verifyLegacy(storage, table, row, apply))));

    // 2. READY integrity.
    const ready = (await db(table)
      .where({ status: 'READY' })
      .select('id', 'job_id', 'storage_key', 'size_bytes', 'hash')) as ReadyRow[];
    results.push(...(await mapPool(ready, concurrency, (row) => verifyReady(storage, table, row, apply, deep))));

    // 3. Stale PENDING (abandoned in-flight uploads). Never touches UNVERIFIED.
    const staleBefore = new Date(Date.now() - STALE_PENDING_MS);
    const stale = await db(table).where({ status: 'PENDING' }).where('created_at', '<', staleBefore).select('id', 'job_id');
    for (const row of stale) {
      const t = apply ? await failFrom(table, row.id, row.job_id, 'PENDING', 'STALE') : null;
      results.push({ table, id: row.id, jobId: row.job_id, kind: 'STALE', reason: 'PENDING past staleness window', transitionedTo: t });
    }
  }

  const findings = results.filter((r) => r.kind === 'MISSING' || r.kind === 'MISMATCH' || r.kind === 'STALE' || r.kind === 'ERROR');
  const verified = results.filter((r) => r.transitionedTo === 'READY').length;
  const failed = results.filter((r) => r.transitionedTo === 'FAILED').length;
  return {
    scanned: results.length,
    results,
    findings,
    verified,
    failed,
    fixed: verified + failed,
    unresolved: findings.length,
    dryRun: !apply,
    deep,
  };
}
