import crypto from 'node:crypto';
import type { Knex } from 'knex';
import { db } from '../../config/database';
import { ApiError } from '../../utils/errors';
import { logAudit } from '../audit/audit.service';
import { jobsBranchScope } from '../../rbac/permissions';
import { isWorkable } from './job-cycle';
import { getStorageProvider } from '../../storage';
import { StorageError } from '../../storage/storage.provider';
import { inspectImage } from '../../utils/image';
import { logger } from '../../utils/logger';
import { countOpenBlockingRisks } from '../risk/risk.service';
import { currentSummaryDigest, buildCompletionSnapshot, buildSignableSummary, getCompletionSnapshot, SUMMARY_SCHEMA_VERSION, SNAPSHOT_SCHEMA_VERSION } from '../completion/summary.service';
import type { AuthUser } from '../../types/auth';

/** Phase 10D: exposes the server-built signable summary + digest to routes. */
export async function getSignableSummary(jobId: number) {
  return buildSignableSummary(jobId);
}
/** Phase 10D: exposes a stored immutable completion snapshot (latest cycle if omitted). */
export async function getCompletionSnapshotFor(jobId: number, cycle?: number) {
  return getCompletionSnapshot(jobId, cycle);
}

interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

const MAX_SIGNATURE_BYTES = 5 * 1024 * 1024;

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export interface CompletionReason {
  code:
    | 'CHECKLIST_NOT_ASSIGNED'
    | 'CHECKLIST_INCOMPLETE'
    | 'STOP_APPROVAL_PENDING'
    | 'STOP_REJECTED'
    | 'REQUIRED_PHOTOS_MISSING'
    | 'INVALID_MEASUREMENT'
    | 'CRITICAL_RISK_UNRESOLVED'
    | 'CUSTOMER_SIGNATURE_REQUIRED';
  message: string;
}

export interface CompletionReadiness {
  canComplete: boolean;
  reasons: CompletionReason[];
  /** Condition breakdown for the readiness UI (§22 list). */
  conditions: {
    checklist: boolean;
    stops: boolean;
    photos: boolean;
    measurements: boolean;
    risks: boolean;
    signature: boolean;
  };
}

function toThousandths(v: number): number {
  return Math.round(v * 1000);
}

/**
 * §22 single completion gate — the ONE place that decides whether a job may
 * be closed. Every fact is recalculated from the database (never from client
 * flags): step states, STOP outcomes, per-attempt photo counts, measurement
 * values re-validated against the template rules, and the signature artifact.
 * The §22 "no unresolved critical issue" condition awaits the §21 risk engine
 * (deferred, documented) — there is no risk data to check yet.
 *
 * This is the DB-truth gate (counts only status=READY). It does NOT touch object
 * storage, so it stays cheap for the readiness endpoint. The authoritative close
 * path additionally calls {@link assertReadyEvidenceObjects} to confirm the
 * READY objects still physically exist and match their size before the job may
 * be completed — see the note on the completion guarantee there.
 */
export async function validateJobCompletion(jobId: number, trx?: Knex.Transaction): Promise<CompletionReadiness> {
  const conn = trx ?? db;
  const reasons: CompletionReason[] = [];
  const conditions = { checklist: true, stops: true, photos: true, measurements: true, risks: true, signature: true };

  const checklist = await conn('job_checklists').where({ job_id: jobId }).first();
  if (!checklist) {
    return {
      canComplete: false,
      reasons: [{ code: 'CHECKLIST_NOT_ASSIGNED', message: 'Ishga checklist biriktirilmagan' }],
      conditions: { checklist: false, stops: false, photos: false, measurements: false, risks: false, signature: false },
    };
  }

  const steps = await conn('job_steps')
    .select(
      'job_steps.id',
      'job_steps.status',
      'job_steps.step_id',
      'checklist_steps.name',
      'checklist_steps.sort_order',
      'checklist_steps.is_stop',
      'checklist_steps.required_photos',
    )
    .join('checklist_steps', 'checklist_steps.id', 'job_steps.step_id')
    .where('job_steps.job_checklist_id', checklist.id)
    .orderBy('checklist_steps.sort_order');

  // 1. Step states: PENDING blocks; STOP steps must be APPROVED —
  //    WAITING_APPROVAL and REJECTED can never satisfy completion.
  const pending = steps.filter((s: any) => s.status === 'PENDING');
  const waiting = steps.filter((s: any) => s.status === 'WAITING_APPROVAL');
  const rejectedSteps = steps.filter((s: any) => s.status === 'REJECTED');
  if (pending.length > 0) {
    conditions.checklist = false;
    reasons.push({
      code: 'CHECKLIST_INCOMPLETE',
      message: `Bajarilmagan bosqichlar: ${pending.map((s: any) => `${s.sort_order}. ${s.name}`).join(', ')}`,
    });
  }
  if (waiting.length > 0) {
    conditions.stops = false;
    reasons.push({
      code: 'STOP_APPROVAL_PENDING',
      message: `Master tasdig'ini kutmoqda: ${waiting.map((s: any) => s.name).join(', ')}`,
    });
  }
  if (rejectedSteps.length > 0) {
    conditions.stops = false;
    reasons.push({
      code: 'STOP_REJECTED',
      message: `Rad etilgan STOP: ${rejectedSteps.map((s: any) => s.name).join(', ')} — tuzatish talab qilinadi`,
    });
  }

  // Per-step relevant attempt: the one covered by the latest STOP decision, or 1.
  const stepIds = steps.map((s: any) => s.id);
  const approvalRows =
    stepIds.length > 0
      ? await conn('stop_approvals').whereIn('job_step_id', stepIds).orderBy('attempt', 'desc')
      : [];
  const latestAttempt = new Map<number, number>();
  for (const a of approvalRows) {
    if (!latestAttempt.has(a.job_step_id)) latestAttempt.set(a.job_step_id, a.attempt);
  }
  const relevantAttempt = (stepId: number) => latestAttempt.get(stepId) ?? 1;

  // 2. §22 photo re-verification: only READY evidence of the relevant attempt
  //    counts (Phase 10B) — PENDING/FAILED rows never satisfy completion, and a
  //    rejected attempt's evidence never counts (Phase 7 semantics).
  for (const s of steps.filter((x: any) => x.required_photos > 0)) {
    const [{ c }] = (await conn('job_photos')
      .where({ job_step_id: s.id, attempt: relevantAttempt(s.id), status: 'READY' })
      .count({ c: '*' })) as [{ c: number | string }];
    if (Number(c) < s.required_photos) {
      conditions.photos = false;
      reasons.push({
        code: 'REQUIRED_PHOTOS_MISSING',
        message: `"${s.name}": foto dalillar yetarli emas (${c}/${s.required_photos})`,
      });
    }
  }

  // 3. §22 measurement re-verification: every required rule has a stored value
  //    for the relevant attempt AND the value still satisfies the inclusive
  //    min/max bounds (integer-thousandth comparison — no raw floats).
  const templateStepIds = steps.map((s: any) => s.step_id);
  const defs =
    templateStepIds.length > 0
      ? await conn('checklist_step_measurements').whereIn('step_id', templateStepIds)
      : [];
  const values =
    stepIds.length > 0 ? await conn('step_measurements').whereIn('job_step_id', stepIds) : [];
  const valueByKey = new Map<string, { value: unknown }>();
  for (const v of values) valueByKey.set(`${v.job_step_id}:${v.measurement_id}:${v.attempt}`, v);

  for (const s of steps) {
    const attempt = relevantAttempt(s.id);
    for (const def of defs.filter((d: any) => d.step_id === s.step_id && d.required)) {
      const row = valueByKey.get(`${s.id}:${def.id}:${attempt}`);
      if (!row) {
        conditions.measurements = false;
        reasons.push({
          code: 'INVALID_MEASUREMENT',
          message: `"${s.name}" — "${def.name}" o'lchovi kiritilmagan`,
        });
        continue;
      }
      const v = toThousandths(Number(row.value));
      const min = def.min_value != null ? toThousandths(Number(def.min_value)) : null;
      const max = def.max_value != null ? toThousandths(Number(def.max_value)) : null;
      if ((min !== null && v < min) || (max !== null && v > max)) {
        conditions.measurements = false;
        reasons.push({
          code: 'INVALID_MEASUREMENT',
          message: `"${s.name}" — "${def.name}" qiymati chegaradan tashqarida (${Number(row.value)} ${def.unit})`,
        });
      }
    }
  }

  const jobForSig = await conn('jobs').where({ id: jobId }).first();
  const currentCycle = jobForSig?.cycle ?? 1;

  // 4. §22 "no unresolved critical issue" (Phase 10D risk engine): a BLOCKING
  //    (CRITICAL) risk of the CURRENT cycle that is still OPEN/MITIGATION
  //    prevents completion. Prior-cycle risks stay visible but do not gate the
  //    current close. The count is recomputed from risk_events under the same
  //    transaction as the close (job row locked), so a blocking risk cannot be
  //    raised concurrently with a successful completion.
  const openBlocking = await countOpenBlockingRisks(conn, jobId, currentCycle);
  if (openBlocking > 0) {
    conditions.risks = false;
    reasons.push({ code: 'CRITICAL_RISK_UNRESOLVED', message: `Hal qilinmagan kritik xavf(lar): ${openBlocking} ta` });
  }

  // 5. §22–23 customer confirmation: a READY signature bound to the CURRENT
  //    completion cycle (Phase 10B). After a reopen the job's cycle advances,
  //    so a pre-reopen signature (older cycle) no longer authorizes the
  //    corrected work — a fresh signature is required.
  const signature = await conn('customer_signatures')
    .where({ job_id: jobId, cycle: currentCycle, status: 'READY' }).whereNull('superseded_at')
    .first();
  if (!signature) {
    conditions.signature = false;
    reasons.push({ code: 'CUSTOMER_SIGNATURE_REQUIRED', message: "Mijoz imzosi hali olinmagan" });
  }

  return { canComplete: reasons.length === 0, reasons, conditions };
}

/**
 * Phase 10B completion-time storage verification.
 *
 * The DB gate proves the metadata is READY; this proves the OBJECT is still
 * physically there. It stats every READY object the gate relies on (required
 * photos of the relevant attempt + the current-cycle signature) and confirms it
 * exists and its size still matches. Run OUTSIDE any transaction so we never
 * hold a job/step row lock during storage network I/O — the same rule the
 * upload path follows.
 *
 * Fails CLOSED with a single stable service error (502 EVIDENCE_UNVERIFIABLE) on
 * any missing object, size mismatch, stat timeout or provider error: the job
 * cannot be completed. It NEVER mutates evidence status — detecting and
 * recording loss (READY -> FAILED) is reconciliation's deliberate, audited job,
 * not a side effect of a completion read.
 *
 * Full sha256 is not re-read here (it is verified at upload and by scheduled
 * deep reconciliation) to keep close latency bounded; existence + current size
 * is the completion-time guarantee. The small window between this check and the
 * close commit is covered by reconciliation and the next completion attempt.
 */
export async function assertReadyEvidenceObjects(jobId: number): Promise<void> {
  const targets: { storageKey: string; size: number }[] = [];

  const checklist = await db('job_checklists').where({ job_id: jobId }).first();
  if (checklist) {
    const steps = await db('job_steps')
      .select('job_steps.id', 'checklist_steps.required_photos')
      .join('checklist_steps', 'checklist_steps.id', 'job_steps.step_id')
      .where('job_steps.job_checklist_id', checklist.id);
    const stepIds = steps.map((s: any) => s.id);
    // Relevant attempt per step — identical rule to validateJobCompletion so the
    // verified objects are exactly the ones the gate counted.
    const approvals =
      stepIds.length > 0 ? await db('stop_approvals').whereIn('job_step_id', stepIds).orderBy('attempt', 'desc') : [];
    const latestAttempt = new Map<number, number>();
    for (const a of approvals) if (!latestAttempt.has(a.job_step_id)) latestAttempt.set(a.job_step_id, a.attempt);

    for (const s of steps.filter((x: any) => x.required_photos > 0)) {
      const rows = await db('job_photos')
        .where({ job_step_id: s.id, attempt: latestAttempt.get(s.id) ?? 1, status: 'READY' })
        .select('storage_key', 'size_bytes');
      for (const r of rows) targets.push({ storageKey: r.storage_key, size: r.size_bytes });
    }
  }

  const job = await db('jobs').where({ id: jobId }).first();
  const currentCycle = job?.cycle ?? 1;
  const sig = await db('customer_signatures')
    .where({ job_id: jobId, cycle: currentCycle, status: 'READY' }).whereNull('superseded_at')
    .orderBy('id', 'desc')
    .first();
  if (sig) targets.push({ storageKey: sig.storage_key, size: sig.size_bytes });

  const storage = getStorageProvider();
  for (const t of targets) {
    let stat: Awaited<ReturnType<typeof storage.stat>>;
    try {
      stat = await storage.stat(t.storageKey);
    } catch (err) {
      logger.warn({ jobId, err }, 'Completion-time evidence stat failed — failing closed');
      throw new ApiError(502, 'EVIDENCE_UNVERIFIABLE', "Dalil fayllarini tekshirib bo'lmadi — keyinroq qayta urinib ko'ring");
    }
    if (!stat || stat.size !== t.size) {
      logger.warn({ jobId, missing: !stat }, 'Completion-time evidence object missing/mismatched — failing closed');
      throw new ApiError(502, 'EVIDENCE_UNVERIFIABLE', "Dalil fayllarini tekshirib bo'lmadi — keyinroq qayta urinib ko'ring");
    }
  }
}

// ---------------------------------------------------------------------------
// Signature (§23)
// ---------------------------------------------------------------------------

async function loadScopedJob(actor: AuthUser, jobId: number, trx?: Knex.Transaction, lock = false) {
  const scope = jobsBranchScope(actor);
  let q = (trx ?? db)('jobs').where({ id: jobId });
  if (lock && trx) q = q.forUpdate();
  const job = await q.first();
  if (!job || (scope !== null && job.branch_id !== scope)) {
    throw ApiError.notFound('Ish topilmadi');
  }
  return job;
}

export interface SignatureDetail {
  id: number;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
}

export async function getSignature(actor: AuthUser, jobId: number): Promise<SignatureDetail | null> {
  const job = await loadScopedJob(actor, jobId);
  const row = await db('customer_signatures')
    .where({ job_id: jobId, cycle: job.cycle, status: 'READY' }).whereNull('superseded_at')
    .orderBy('id', 'desc')
    .first();
  if (!row) return null;
  return { id: row.id, mimeType: row.mime_type, sizeBytes: row.size_bytes, createdAt: row.created_at };
}

export async function getSignatureStream(
  actor: AuthUser,
  jobId: number,
): Promise<{ stream: import('node:stream').Readable; mimeType: string; sizeBytes: number }> {
  const job = await loadScopedJob(actor, jobId);
  const row = await db('customer_signatures')
    .where({ job_id: jobId, cycle: job.cycle, status: 'READY' }).whereNull('superseded_at')
    .orderBy('id', 'desc')
    .first();
  if (!row) throw ApiError.notFound('Imzo topilmadi');
  try {
    const stream = await getStorageProvider().getStream(row.storage_key);
    return { stream, mimeType: row.mime_type, sizeBytes: row.size_bytes };
  } catch (err) {
    if (err instanceof StorageError && err.kind === 'NOT_FOUND') throw ApiError.notFound('Imzo topilmadi');
    throw err;
  }
}

/**
 * §23 + Phase 10B: the customer signs at the end of the work. Two-transaction
 * safe upload (register PENDING → storage put+verify → finalize READY), bound
 * to the job's CURRENT cycle so a reopened job requires a fresh signature.
 * Allowed only while IN_PROGRESS with a completed checklist; one READY
 * signature per cycle; customer_id/cycle/timestamps are server-derived.
 */
export async function saveSignature(
  actor: AuthUser,
  jobId: number,
  file: { buffer: Buffer },
  meta: RequestMeta,
  summaryDigest?: string,
): Promise<SignatureDetail> {
  const info = inspectImage(file.buffer);
  if ('error' in info) {
    if (info.error === 'IMAGE_TOO_LARGE') {
      throw new ApiError(422, 'IMAGE_TOO_LARGE', "Imzo rasmi o'lchami juda katta");
    }
    throw new ApiError(422, 'INVALID_FILE_TYPE', 'Imzo rasm fayli sifatida yuborilishi kerak (PNG/JPEG/WebP)');
  }
  const mime = info.mime;
  if (file.buffer.length > MAX_SIGNATURE_BYTES) {
    throw new ApiError(422, 'FILE_TOO_LARGE', 'Imzo fayli juda katta (maksimum 5 MB)');
  }

  const storageKey = `signatures/${jobId}/${crypto.randomUUID()}.${EXT_BY_MIME[mime]}`;
  const hash = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const size = file.buffer.length;

  // ---- TX1: register PENDING under the job lock ----
  const registered = await db.transaction(async (trx) => {
    const job = await loadScopedJob(actor, jobId, trx, true);
    // Signable while the job is doing work — IN_PROGRESS or, in a §24 reopen
    // cycle, REOPENED (the customer re-signs the corrected work).
    if (!isWorkable(job)) {
      throw ApiError.conflict("Imzo faqat ish jarayonida olinadi", 'JOB_NOT_IN_PROGRESS');
    }
    const checklist = await trx('job_checklists').where({ job_id: jobId }).first();
    if (!checklist || !checklist.completed_at) {
      throw ApiError.conflict("Imzo olishdan avval checklist to'liq yakunlanishi kerak", 'CHECKLIST_INCOMPLETE');
    }
    // Phase 10D (§23): bind the signature to the EXACT signable work summary.
    // The server recomputes the authoritative digest under the lock; if the
    // client submitted the digest it displayed and it no longer matches (the
    // work changed after the summary was shown), reject as stale.
    const boundDigest = await currentSummaryDigest(jobId, trx);
    if (summaryDigest && boundDigest && summaryDigest !== boundDigest) {
      throw ApiError.conflict('Ish tafsiloti o\'zgardi — yangilangan xulosani qayta ko\'ring va imzolang', 'SUMMARY_STALE');
    }
    // At most one ACTIVE (non-superseded) READY/PENDING signature per cycle.
    // Phase 10D re-sign: if the active READY signature no longer matches the
    // current summary (something material changed), supersede it (kept in
    // history, never overwritten) and allow a fresh signature. A still-matching
    // signature blocks a needless duplicate.
    const existing = await trx('customer_signatures')
      .where({ job_id: jobId, cycle: job.cycle })
      .whereIn('status', ['PENDING', 'READY'])
      .whereNull('superseded_at')
      .orderBy('id', 'desc')
      .first();
    if (existing) {
      if (existing.status === 'PENDING' || existing.summary_digest === boundDigest) {
        throw ApiError.conflict('Bu ish uchun mijoz imzosi allaqachon olingan', 'SIGNATURE_EXISTS');
      }
      await trx('customer_signatures').where({ id: existing.id }).update({ superseded_at: trx.fn.now() });
      await logAudit(
        { userId: actor.id, action: 'SIGNATURE_INVALIDATED', entityType: 'job', entityId: jobId, oldValue: { signatureId: existing.id }, newValue: { reason: 'SUMMARY_CHANGED', cycle: job.cycle }, ...meta },
        trx,
      );
    }

    const [newId] = await trx('customer_signatures').insert({
      job_id: jobId,
      customer_id: job.customer_id, // server-derived, never client-supplied
      cycle: job.cycle,
      status: 'PENDING',
      storage_key: storageKey,
      mime_type: mime,
      content_type: mime,
      size_bytes: size,
      hash,
      summary_digest: boundDigest,
      summary_schema_version: SUMMARY_SCHEMA_VERSION,
    });

    await logAudit(
      {
        userId: actor.id,
        action: 'SIGNATURE_UPLOAD_STARTED',
        entityType: 'job',
        entityId: jobId,
        newValue: { signatureId: newId, customerId: job.customer_id, cycle: job.cycle },
        ...meta,
      },
      trx,
    );
    return { id: newId as number, cycle: job.cycle as number };
  });

  // ---- STORAGE PUT + verify ----
  try {
    const stat = await getStorageProvider().put(storageKey, file.buffer, { contentType: mime, sha256: hash });
    if (stat.size !== size) throw new StorageError('IO', `Stored size ${stat.size} != expected ${size}`);
  } catch (err) {
    await markSignatureFailed(registered.id, err instanceof StorageError ? `STORAGE_${err.kind}` : 'STORAGE_WRITE', actor, jobId, meta);
    logger.error({ err, signatureId: registered.id }, 'Signature storage write failed');
    throw new ApiError(502, 'STORAGE_UNAVAILABLE', "Imzoni saqlashda xatolik — qayta urinib ko'ring");
  }

  // ---- TX2: finalize READY (or supersede if the job moved on) ----
  const finalized = await db.transaction(async (trx) => {
    const row = await trx('customer_signatures').where({ id: registered.id }).forUpdate().first();
    if (!row || row.status !== 'PENDING') return { ok: false as const };
    const job = await trx('jobs').where({ id: jobId }).forUpdate().first();
    const stillValid = job && isWorkable(job) && job.cycle === registered.cycle;
    if (!stillValid) {
      await trx('customer_signatures')
        .where({ id: registered.id })
        .update({ status: 'FAILED', failed_at: trx.fn.now(), failure_reason: 'SUPERSEDED' });
      await logAudit(
        { userId: actor.id, action: 'SIGNATURE_UPLOAD_FAILED', entityType: 'job', entityId: jobId, newValue: { signatureId: registered.id, reason: 'SUPERSEDED' }, ...meta },
        trx,
      );
      return { ok: false as const };
    }
    await trx('customer_signatures').where({ id: registered.id }).update({ status: 'READY', ready_at: trx.fn.now() });
    await logAudit(
      {
        userId: actor.id,
        action: 'CUSTOMER_SIGNED',
        entityType: 'job',
        entityId: jobId,
        newValue: { signatureId: registered.id, customerId: row.customer_id, cycle: registered.cycle, hash },
        ...meta,
      },
      trx,
    );
    return { ok: true as const };
  });

  if (!finalized.ok) {
    await getStorageProvider()
      .delete(storageKey)
      .catch((err) => logger.warn({ err, storageKey }, 'Orphan signature object delete failed (reconciliation will catch it)'));
    throw ApiError.conflict("Ish holati o'zgardi — imzo qabul qilinmadi", 'JOB_STATE_CHANGED');
  }

  return (await getSignature(actor, jobId))!;
}

async function markSignatureFailed(
  id: number,
  reason: string,
  actor: AuthUser,
  jobId: number,
  meta: RequestMeta,
): Promise<void> {
  await db.transaction(async (trx) => {
    const row = await trx('customer_signatures').where({ id }).forUpdate().first();
    if (!row || row.status !== 'PENDING') return;
    await trx('customer_signatures')
      .where({ id })
      .update({ status: 'FAILED', failed_at: trx.fn.now(), failure_reason: reason.slice(0, 60) });
    await logAudit(
      { userId: actor.id, action: 'SIGNATURE_UPLOAD_FAILED', entityType: 'job', entityId: jobId, newValue: { signatureId: id, reason: reason.slice(0, 60) }, ...meta },
      trx,
    );
  });
}

// ---------------------------------------------------------------------------
// Phase 10D: signable-summary freshness + immutable completion snapshot
// ---------------------------------------------------------------------------

/**
 * A READY signature must still match the CURRENT work summary at completion
 * time. If anything material changed after the customer signed (installation,
 * checklist attempt/evidence, STOP/risk state, assignee, identity, cycle,
 * checklist version), the digest differs → the signature is stale and a fresh
 * one is required. Runs under the job lock inside the close transaction.
 */
async function assertSignatureFresh(trx: Knex.Transaction, jobId: number, cycle: number): Promise<void> {
  const sig = await trx('customer_signatures').where({ job_id: jobId, cycle, status: 'READY' }).whereNull('superseded_at').orderBy('id', 'desc').first();
  if (!sig) return; // the gate already requires a signature; nothing to compare
  const current = await currentSummaryDigest(jobId, trx);
  if (sig.summary_digest && current && sig.summary_digest !== current) {
    throw new ApiError(409, 'SIGNATURE_STALE', 'Imzo eskirgan — ish tafsiloti o\'zgardi, mijoz qayta imzolashi kerak');
  }
}

/**
 * Finalizes the immutable completion snapshot for a cycle inside the close
 * transaction. Idempotent (unique job_id+cycle); server-built from authoritative
 * rows; the digest binds the summary + the accepted signature.
 */
async function finalizeSnapshot(trx: Knex.Transaction, jobId: number, cycle: number, actorId: number, meta: RequestMeta): Promise<void> {
  const existing = await trx('completion_snapshots').where({ job_id: jobId, cycle }).first();
  if (existing) return;
  const built = await buildCompletionSnapshot(trx, jobId, cycle, actorId);
  await trx('completion_snapshots').insert({
    job_id: jobId,
    cycle,
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    provenance: 'FINALIZED',
    content: JSON.stringify(built.content),
    digest: built.digest,
    summary_digest: built.summaryDigest,
    signature_hash: built.signatureHash,
    finalized_by: actorId,
  });
  await logAudit(
    { userId: actorId, action: 'COMPLETION_SNAPSHOT_FINALIZED', entityType: 'job', entityId: jobId, newValue: { cycle, digest: built.digest, schemaVersion: SNAPSHOT_SCHEMA_VERSION }, ...meta },
    trx,
  );
}

// ---------------------------------------------------------------------------
// Master close (§22)
// ---------------------------------------------------------------------------

/**
 * Master close (jobs.close), the §22 gate runs INSIDE the locked transaction.
 * First cycle: IN_PROGRESS → COMPLETED (closed_by/closed_at set).
 * Reopened cycle (§24): REOPENED → QUALITY_REVIEW — the corrected work goes to
 * quality for final acceptance instead of closing directly; the second
 * completion happens in confirmQuality. Concurrent closes/approvals serialize
 * on the job row lock; failure = rollback, zero partial state.
 */
export async function closeJob(actor: AuthUser, jobId: number, meta: RequestMeta): Promise<void> {
  // Pre-lock: scope + status + DB readiness, then completion-time object
  // verification. Storage I/O runs here, BEFORE the write lock, so we never hold
  // the job/step row locks during a storage stat (same rule as the upload path).
  const pre = await loadScopedJob(actor, jobId);
  if (pre.status !== 'IN_PROGRESS' && pre.status !== 'REOPENED') {
    throw ApiError.conflict(`Bu holatdagi ishni yopib bo'lmaydi (${pre.status})`, 'JOB_NOT_CLOSABLE');
  }
  const preReadiness = await validateJobCompletion(jobId);
  if (!preReadiness.canComplete) {
    throw new ApiError(422, 'COMPLETION_BLOCKED', "Ishni yopish shartlari to'liq bajarilmagan", preReadiness.reasons);
  }
  await assertReadyEvidenceObjects(jobId);

  await db.transaction(async (trx) => {
    const job = await loadScopedJob(actor, jobId, trx, true);
    const reopenCycle = job.status === 'REOPENED';
    if (job.status !== 'IN_PROGRESS' && !reopenCycle) {
      throw ApiError.conflict(`Bu holatdagi ishni yopib bo'lmaydi (${job.status})`, 'JOB_NOT_CLOSABLE');
    }

    // Defense in depth: the DB gate must still hold under the lock.
    const readiness = await validateJobCompletion(jobId, trx);
    if (!readiness.canComplete) {
      throw new ApiError(422, 'COMPLETION_BLOCKED', "Ishni yopish shartlari to'liq bajarilmagan", readiness.reasons);
    }
    // Phase 10D: the accepted signature must still match the current summary.
    const cycle = job.cycle ?? 1;
    await assertSignatureFresh(trx, jobId, cycle);

    if (reopenCycle) {
      await trx('jobs').where({ id: jobId }).update({ status: 'QUALITY_REVIEW', updated_at: trx.fn.now() });
      await logAudit(
        {
          userId: actor.id,
          action: 'QUALITY_REVIEW_REQUESTED',
          entityType: 'job',
          entityId: jobId,
          oldValue: { status: 'REOPENED' },
          newValue: { status: 'QUALITY_REVIEW', conditions: readiness.conditions },
          ...meta,
        },
        trx,
      );
      return;
    }

    await trx('jobs')
      .where({ id: jobId })
      .update({ status: 'COMPLETED', closed_by: actor.id, closed_at: trx.fn.now(), updated_at: trx.fn.now() });

    await logAudit(
      {
        userId: actor.id,
        action: 'JOB_CLOSED',
        entityType: 'job',
        entityId: jobId,
        oldValue: { status: 'IN_PROGRESS' },
        newValue: { status: 'COMPLETED', conditions: readiness.conditions },
        ...meta,
      },
      trx,
    );
    // Phase 10D: immutable completion snapshot for this cycle (idempotent).
    await finalizeSnapshot(trx, jobId, cycle, actor.id, meta);
  });
}

// ---------------------------------------------------------------------------
// §24 reopen + quality confirmation
// ---------------------------------------------------------------------------

/**
 * COMPLETED → REOPENED (jobs.reopen: SIFAT/ADMIN per §4). Mandatory reason,
 * stored per §24 (reopen_reason/reopened_by/reopened_at). Nothing else moves:
 * the original completion, signature, checklist, STOP history, photos and
 * audit rows all remain untouched (the previous JOB_CLOSED audit preserves
 * the first completion permanently).
 */
export async function reopenJob(actor: AuthUser, jobId: number, reason: string, meta: RequestMeta): Promise<void> {
  await db.transaction(async (trx) => {
    const job = await loadScopedJob(actor, jobId, trx, true);
    if (job.status !== 'COMPLETED') {
      throw ApiError.conflict("Faqat yakunlangan (COMPLETED) ishni qayta ochish mumkin", 'JOB_NOT_COMPLETED');
    }

    // Phase 10B: advance the completion cycle so the prior signature no longer
    // authorizes the corrected work — a fresh READY signature will be required
    // before re-completion. The old signature stays in history, marked
    // superseded (never deleted).
    const newCycle = (job.cycle ?? 1) + 1;
    await trx('jobs').where({ id: jobId }).update({
      status: 'REOPENED',
      cycle: newCycle,
      reopen_reason: reason,
      reopened_by: actor.id,
      reopened_at: trx.fn.now(),
      updated_at: trx.fn.now(),
    });

    const superseded = await trx('customer_signatures')
      .where({ job_id: jobId, cycle: job.cycle ?? 1, status: 'READY' })
      .update({ superseded_at: trx.fn.now() });

    await logAudit(
      {
        userId: actor.id,
        action: 'JOB_REOPENED',
        entityType: 'job',
        entityId: jobId,
        oldValue: { status: 'COMPLETED', cycle: job.cycle ?? 1 },
        newValue: { status: 'REOPENED', cycle: newCycle, reason },
        ...meta,
      },
      trx,
    );
    if (superseded > 0) {
      await logAudit(
        {
          userId: actor.id,
          action: 'SIGNATURE_SUPERSEDED',
          entityType: 'job',
          entityId: jobId,
          oldValue: { cycle: job.cycle ?? 1 },
          newValue: { reason: 'JOB_REOPENED', newCycle },
          ...meta,
        },
        trx,
      );
    }
  });
}

/**
 * QUALITY_REVIEW → COMPLETED (§24's final step) — the quality authority
 * (jobs.reopen holders) accepts the corrected work. This IS the second
 * completion: closed_by/closed_at now reflect it, while the original
 * completion stays permanently in the first JOB_CLOSED audit row.
 */
export async function confirmQuality(actor: AuthUser, jobId: number, meta: RequestMeta): Promise<void> {
  // Pre-lock: status + DB readiness + completion-time object verification
  // (storage I/O outside the write lock — see closeJob).
  const pre = await loadScopedJob(actor, jobId);
  if (pre.status !== 'QUALITY_REVIEW') {
    throw ApiError.conflict("Bu ish sifat nazorati bosqichida emas", 'JOB_NOT_IN_QUALITY_REVIEW');
  }
  const preReadiness = await validateJobCompletion(jobId);
  if (!preReadiness.canComplete) {
    throw new ApiError(422, 'COMPLETION_BLOCKED', "Ishni yopish shartlari to'liq bajarilmagan", preReadiness.reasons);
  }
  await assertReadyEvidenceObjects(jobId);

  await db.transaction(async (trx) => {
    const job = await loadScopedJob(actor, jobId, trx, true);
    if (job.status !== 'QUALITY_REVIEW') {
      throw ApiError.conflict("Bu ish sifat nazorati bosqichida emas", 'JOB_NOT_IN_QUALITY_REVIEW');
    }

    // Defense in depth: the gate must still hold at acceptance time.
    const readiness = await validateJobCompletion(jobId, trx);
    if (!readiness.canComplete) {
      throw new ApiError(422, 'COMPLETION_BLOCKED', "Ishni yopish shartlari to'liq bajarilmagan", readiness.reasons);
    }
    const cycle = job.cycle ?? 1;
    await assertSignatureFresh(trx, jobId, cycle);

    await trx('jobs')
      .where({ id: jobId })
      .update({ status: 'COMPLETED', closed_by: actor.id, closed_at: trx.fn.now(), updated_at: trx.fn.now() });

    await logAudit(
      {
        userId: actor.id,
        action: 'JOB_CLOSED',
        entityType: 'job',
        entityId: jobId,
        oldValue: { status: 'QUALITY_REVIEW' },
        newValue: { status: 'COMPLETED', conditions: readiness.conditions, qualityConfirmed: true },
        ...meta,
      },
      trx,
    );
    // Phase 10D: immutable completion snapshot for the reopened cycle.
    await finalizeSnapshot(trx, jobId, cycle, actor.id, meta);
  });
}
