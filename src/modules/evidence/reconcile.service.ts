import { db } from '../../config/database';
import { logAudit } from '../audit/audit.service';
import { getStorageProvider } from '../../storage';
import { StorageError } from '../../storage/storage.provider';

/**
 * Phase 10B evidence reconciliation.
 *
 * Compares database evidence metadata against the object store to detect
 * integrity problems. DRY-RUN BY DEFAULT — it never deletes objects and, with
 * `fix: false`, never mutates the database. With `fix: true` it transitions
 * READY rows whose object is missing or size-mismatched to FAILED (they stop
 * counting toward completion) and records an EVIDENCE_INTEGRITY_FAILURE audit
 * event; it still never deletes objects.
 *
 * Checks (DB → storage direction, the safety-critical one):
 *  - MISSING   — a READY row whose object is absent.
 *  - MISMATCH  — a READY row whose stored size differs from the recorded size.
 *  - STALE     — a PENDING row older than the staleness window (an interrupted
 *                upload); reported, and with `fix` marked FAILED(STALE).
 */
export interface EvidenceFinding {
  kind: 'MISSING' | 'MISMATCH' | 'STALE';
  table: 'job_photos' | 'customer_signatures';
  id: number;
  jobId: number;
  storageKey: string;
  detail: string;
}

export interface ReconcileResult {
  scanned: number;
  findings: EvidenceFinding[];
  fixed: number;
  dryRun: boolean;
}

const STALE_PENDING_MS = 15 * 60 * 1000; // an upload older than 15 min is abandoned

async function scanTable(
  table: 'job_photos' | 'customer_signatures',
  fix: boolean,
): Promise<{ scanned: number; findings: EvidenceFinding[]; fixed: number }> {
  const storage = getStorageProvider();
  const findings: EvidenceFinding[] = [];
  let fixed = 0;

  const ready = await db(table).where({ status: 'READY' }).select('id', 'job_id', 'storage_key', 'size_bytes');
  for (const row of ready) {
    let stat: Awaited<ReturnType<typeof storage.stat>> = null;
    try {
      stat = await storage.stat(row.storage_key);
    } catch (err) {
      // A transient storage error is reported as MISSING-equivalent but never
      // auto-fixed (we cannot prove the object is gone).
      findings.push({
        kind: 'MISSING',
        table,
        id: row.id,
        jobId: row.job_id,
        storageKey: row.storage_key,
        detail: err instanceof StorageError ? `stat failed: ${err.kind}` : 'stat failed',
      });
      continue;
    }
    if (!stat) {
      findings.push({ kind: 'MISSING', table, id: row.id, jobId: row.job_id, storageKey: row.storage_key, detail: 'object absent' });
      if (fix) fixed += await failReady(table, row.id, row.job_id, 'MISSING_OBJECT');
    } else if (stat.size !== row.size_bytes) {
      findings.push({
        kind: 'MISMATCH',
        table,
        id: row.id,
        jobId: row.job_id,
        storageKey: row.storage_key,
        detail: `size ${stat.size} != recorded ${row.size_bytes}`,
      });
      if (fix) fixed += await failReady(table, row.id, row.job_id, 'SIZE_MISMATCH');
    }
  }

  const staleBefore = new Date(Date.now() - STALE_PENDING_MS);
  const stale = await db(table)
    .where({ status: 'PENDING' })
    .where('created_at', '<', staleBefore)
    .select('id', 'job_id', 'storage_key');
  for (const row of stale) {
    findings.push({ kind: 'STALE', table, id: row.id, jobId: row.job_id, storageKey: row.storage_key, detail: 'PENDING past staleness window' });
    if (fix) {
      await db(table).where({ id: row.id, status: 'PENDING' }).update({ status: 'FAILED', failed_at: db.fn.now(), failure_reason: 'STALE' });
      fixed += 1;
    }
  }

  return { scanned: ready.length + stale.length, findings, fixed };
}

/** Transitions a READY row to FAILED and audits it. Returns 1 if it changed a row. */
async function failReady(table: 'job_photos' | 'customer_signatures', id: number, jobId: number, reason: string): Promise<number> {
  return db.transaction(async (trx) => {
    const row = await trx(table).where({ id, status: 'READY' }).forUpdate().first();
    if (!row) return 0;
    await trx(table).where({ id }).update({ status: 'FAILED', failed_at: trx.fn.now(), failure_reason: reason });
    await logAudit(
      {
        userId: null,
        action: 'EVIDENCE_INTEGRITY_FAILURE',
        entityType: table === 'job_photos' ? 'job_photo' : 'job',
        entityId: table === 'job_photos' ? id : jobId,
        oldValue: { status: 'READY' },
        newValue: { table, id, reason },
        ip: null,
        userAgent: 'reconcile',
      },
      trx,
    );
    return 1;
  });
}

export async function reconcileEvidence(options: { fix?: boolean } = {}): Promise<ReconcileResult> {
  const fix = options.fix ?? false;
  const photos = await scanTable('job_photos', fix);
  const signatures = await scanTable('customer_signatures', fix);
  return {
    scanned: photos.scanned + signatures.scanned,
    findings: [...photos.findings, ...signatures.findings],
    fixed: photos.fixed + signatures.fixed,
    dryRun: !fix,
  };
}
