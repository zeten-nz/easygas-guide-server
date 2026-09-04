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
import type { AuthUser } from '../../types/auth';

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
 */
export async function validateJobCompletion(jobId: number, trx?: Knex.Transaction): Promise<CompletionReadiness> {
  const conn = trx ?? db;
  const reasons: CompletionReason[] = [];
  const conditions = { checklist: true, stops: true, photos: true, measurements: true, signature: true };

  const checklist = await conn('job_checklists').where({ job_id: jobId }).first();
  if (!checklist) {
    return {
      canComplete: false,
      reasons: [{ code: 'CHECKLIST_NOT_ASSIGNED', message: 'Ishga checklist biriktirilmagan' }],
      conditions: { checklist: false, stops: false, photos: false, measurements: false, signature: false },
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

  // 4. §22–23 customer confirmation: a READY signature bound to the CURRENT
  //    completion cycle (Phase 10B). After a reopen the job's cycle advances,
  //    so a pre-reopen signature (older cycle) no longer authorizes the
  //    corrected work — a fresh signature is required.
  const jobForSig = await conn('jobs').where({ id: jobId }).first();
  const currentCycle = jobForSig?.cycle ?? 1;
  const signature = await conn('customer_signatures')
    .where({ job_id: jobId, cycle: currentCycle, status: 'READY' })
    .first();
  if (!signature) {
    conditions.signature = false;
    reasons.push({ code: 'CUSTOMER_SIGNATURE_REQUIRED', message: "Mijoz imzosi hali olinmagan" });
  }

  return { canComplete: reasons.length === 0, reasons, conditions };
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
    .where({ job_id: jobId, cycle: job.cycle, status: 'READY' })
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
    .where({ job_id: jobId, cycle: job.cycle, status: 'READY' })
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
    // At most one READY (or in-flight PENDING) signature for the current cycle.
    const existing = await trx('customer_signatures')
      .where({ job_id: jobId, cycle: job.cycle })
      .whereIn('status', ['PENDING', 'READY'])
      .first();
    if (existing) {
      throw ApiError.conflict('Bu ish uchun mijoz imzosi allaqachon olingan', 'SIGNATURE_EXISTS');
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
  await db.transaction(async (trx) => {
    const job = await loadScopedJob(actor, jobId, trx, true);
    const reopenCycle = job.status === 'REOPENED';
    if (job.status !== 'IN_PROGRESS' && !reopenCycle) {
      throw ApiError.conflict(`Bu holatdagi ishni yopib bo'lmaydi (${job.status})`, 'JOB_NOT_CLOSABLE');
    }

    const readiness = await validateJobCompletion(jobId, trx);
    if (!readiness.canComplete) {
      throw new ApiError(422, 'COMPLETION_BLOCKED', "Ishni yopish shartlari to'liq bajarilmagan", readiness.reasons);
    }

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
  });
}
