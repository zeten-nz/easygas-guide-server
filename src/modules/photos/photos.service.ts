import crypto from 'node:crypto';
import type { Readable } from 'node:stream';
import { db } from '../../config/database';
import { ApiError } from '../../utils/errors';
import { logAudit } from '../audit/audit.service';
import { logger } from '../../utils/logger';
import { jobsBranchScope } from '../../rbac/permissions';
import { isWorkable } from '../jobs/job-cycle';
import { getStorageProvider } from '../../storage';
import { StorageError } from '../../storage/storage.provider';
import { inspectImage, type ImageMime } from '../../utils/image';
import type { AuthUser } from '../../types/auth';

interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // 10 MB (§34 upload size limits)
export const MAX_PHOTOS_PER_ATTEMPT = 10;

/**
 * Content sniffing — kept for backward compatibility with the signature flow
 * and existing tests. Prefer inspectImage() which also bounds dimensions.
 */
export function detectImageType(buffer: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  const info = inspectImage(buffer);
  return 'mime' in info ? info.mime : null;
}

const EXT_BY_MIME: Record<ImageMime, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

async function loadScopedJob(actor: AuthUser, jobId: number) {
  const scope = jobsBranchScope(actor);
  const job = await db('jobs').where({ id: jobId }).first();
  if (!job || (scope !== null && job.branch_id !== scope)) {
    throw ApiError.notFound('Ish topilmadi');
  }
  return job;
}

export interface PhotoDetail {
  id: number;
  attempt: number;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedByName: string;
  createdAt: Date;
}

/** Maps a low-level image inspection error to the client-facing ApiError. */
function assertImage(buffer: Buffer): { mime: ImageMime } {
  if (buffer.length > MAX_PHOTO_BYTES) {
    throw new ApiError(422, 'FILE_TOO_LARGE', 'Fayl juda katta (maksimum 10 MB)');
  }
  const info = inspectImage(buffer);
  if ('error' in info) {
    if (info.error === 'IMAGE_TOO_LARGE') {
      throw new ApiError(422, 'IMAGE_TOO_LARGE', "Rasm o'lchami juda katta (piksel chegarasidan oshib ketdi)");
    }
    throw new ApiError(422, 'INVALID_FILE_TYPE', 'Faqat JPEG, PNG yoki WebP rasm fayllari qabul qilinadi');
  }
  return { mime: info.mime };
}

/**
 * Phase 10B safe evidence upload — a two-transaction state machine with the
 * storage write BETWEEN the transactions (a DB transaction can never span
 * object storage):
 *
 *   TX1: lock job+step, re-validate workable state / step PENDING / attempt /
 *        count limit, INSERT the row as PENDING, audit PHOTO_UPLOAD_STARTED.
 *   PUT: write the object, then stat() it and verify the stored size.
 *   TX2: lock job+step again, re-validate the SAME attempt still PENDING, then
 *        flip PENDING→READY (+ready_at) and audit PHOTO_UPLOAD_READY.
 *
 * Invariants:
 *  - The completion gate counts only READY rows, so a crash between TX1 and TX2
 *    leaves a PENDING row that never counts as evidence (reconciliation cleans
 *    it). No row becomes READY before its object is written and size-verified;
 *    an object can still be lost or altered externally AFTER it is READY, which
 *    is why completion re-checks existence+size (assertReadyEvidenceObjects) and
 *    reconciliation re-verifies periodically.
 *  - A storage failure marks the row FAILED (no valid evidence) and rethrows.
 *  - If the workflow moved on (cancel/complete/reopen/new attempt) before TX2,
 *    the row is marked FAILED(SUPERSEDED) and the just-written object deleted —
 *    attempt-1 evidence can never satisfy attempt 2.
 */
export async function uploadStepPhoto(
  actor: AuthUser,
  jobId: number,
  jobStepId: number,
  file: { buffer: Buffer; originalname: string },
  meta: RequestMeta,
): Promise<PhotoDetail> {
  const job = await loadScopedJob(actor, jobId);
  if (!isWorkable(job)) {
    throw ApiError.conflict("Foto yuklash uchun ish ish jarayonida bo'lishi kerak", 'JOB_NOT_IN_PROGRESS');
  }

  const { mime } = assertImage(file.buffer);
  const hash = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const storageKey = `photos/${jobId}/${jobStepId}/${crypto.randomUUID()}.${EXT_BY_MIME[mime]}`;
  const size = file.buffer.length;

  // ---- TX1: register PENDING under the job+step lock ----
  const registered = await db.transaction(async (trx) => {
    const checklist = await trx('job_checklists').where({ job_id: jobId }).first();
    if (!checklist) throw ApiError.notFound('Bu ishga checklist biriktirilmagan');

    const jobStep = await trx('job_steps')
      .where({ id: jobStepId, job_checklist_id: checklist.id })
      .forUpdate()
      .first();
    if (!jobStep) throw ApiError.notFound('Bosqich topilmadi');
    if (jobStep.status !== 'PENDING') {
      throw ApiError.conflict("Yuborilgan/yakunlangan bosqichga foto qo'shib bo'lmaydi", 'STEP_NOT_PENDING');
    }
    const attempt = jobStep.attempt as number;

    // Only READY (or in-flight PENDING) rows of THIS attempt count toward the limit.
    const [{ c: existing }] = (await trx('job_photos')
      .where({ job_step_id: jobStepId, attempt })
      .whereIn('status', ['PENDING', 'READY'])
      .count({ c: '*' })) as [{ c: number | string }];
    if (Number(existing) >= MAX_PHOTOS_PER_ATTEMPT) {
      throw ApiError.conflict(`Bir urinish uchun ko'pi bilan ${MAX_PHOTOS_PER_ATTEMPT} ta rasm yuklash mumkin`, 'PHOTO_LIMIT');
    }

    const [newId] = await trx('job_photos').insert({
      job_id: jobId,
      job_step_id: jobStepId,
      attempt,
      status: 'PENDING',
      storage_key: storageKey,
      original_name: file.originalname.slice(0, 255),
      mime_type: mime,
      content_type: mime,
      size_bytes: size,
      hash,
      created_by: actor.id,
    });

    await logAudit(
      {
        userId: actor.id,
        action: 'PHOTO_UPLOAD_STARTED',
        entityType: 'job_photo',
        entityId: newId,
        newValue: { jobId, jobStepId, attempt, mime, sizeBytes: size },
        ...meta,
      },
      trx,
    );

    return { id: newId as number, attempt };
  });

  // ---- STORAGE PUT + verify (outside any transaction) ----
  try {
    const stat = await getStorageProvider().put(storageKey, file.buffer, { contentType: mime, sha256: hash });
    if (stat.size !== size) {
      throw new StorageError('IO', `Stored size ${stat.size} != expected ${size}`);
    }
  } catch (err) {
    await markPhotoFailed(registered.id, err instanceof StorageError ? `STORAGE_${err.kind}` : 'STORAGE_WRITE', actor, meta);
    logger.error({ err, photoId: registered.id }, 'Photo storage write failed');
    throw new ApiError(502, 'STORAGE_UNAVAILABLE', "Faylni saqlashda xatolik — qayta urinib ko'ring");
  }

  // ---- TX2: finalize READY (or supersede if the workflow moved on) ----
  const finalized = await db.transaction(async (trx) => {
    const row = await trx('job_photos').where({ id: registered.id }).forUpdate().first();
    if (!row || row.status !== 'PENDING') {
      return { ok: false as const };
    }
    const jobRow = await trx('jobs').where({ id: jobId }).forUpdate().first();
    const jobStep = await trx('job_steps').where({ id: jobStepId }).forUpdate().first();
    const stillValid =
      jobRow && isWorkable(jobRow) && jobStep && jobStep.status === 'PENDING' && jobStep.attempt === registered.attempt;

    if (!stillValid) {
      await trx('job_photos')
        .where({ id: registered.id })
        .update({ status: 'FAILED', failed_at: trx.fn.now(), failure_reason: 'SUPERSEDED' });
      await logAudit(
        {
          userId: actor.id,
          action: 'PHOTO_UPLOAD_FAILED',
          entityType: 'job_photo',
          entityId: registered.id,
          newValue: { jobId, jobStepId, reason: 'SUPERSEDED' },
          ...meta,
        },
        trx,
      );
      return { ok: false as const };
    }

    await trx('job_photos').where({ id: registered.id }).update({ status: 'READY', ready_at: trx.fn.now() });
    await logAudit(
      {
        userId: actor.id,
        action: 'PHOTO_UPLOAD_READY',
        entityType: 'job_photo',
        entityId: registered.id,
        newValue: { jobId, jobStepId, attempt: registered.attempt, sizeBytes: size, hash },
        ...meta,
      },
      trx,
    );
    return { ok: true as const };
  });

  if (!finalized.ok) {
    // The workflow moved on: the object we wrote is not referenced by valid
    // evidence, so it is safe to remove (best-effort; failure is logged only).
    await getStorageProvider()
      .delete(storageKey)
      .catch((err) => logger.warn({ err, storageKey }, 'Orphan photo object delete failed (reconciliation will catch it)'));
    throw ApiError.conflict('Bosqich holati o\'zgardi — rasm qabul qilinmadi', 'STEP_STATE_CHANGED');
  }

  const detail = await db('job_photos')
    .select('job_photos.*', 'users.first_name', 'users.last_name')
    .join('users', 'users.id', 'job_photos.created_by')
    .where('job_photos.id', registered.id)
    .first();
  return {
    id: detail.id,
    attempt: detail.attempt,
    originalName: detail.original_name,
    mimeType: detail.mime_type,
    sizeBytes: detail.size_bytes,
    uploadedByName: `${detail.first_name} ${detail.last_name}`,
    createdAt: detail.created_at,
  };
}

async function markPhotoFailed(id: number, reason: string, actor: AuthUser, meta: RequestMeta): Promise<void> {
  await db.transaction(async (trx) => {
    const row = await trx('job_photos').where({ id }).forUpdate().first();
    if (!row || row.status !== 'PENDING') return;
    await trx('job_photos')
      .where({ id })
      .update({ status: 'FAILED', failed_at: trx.fn.now(), failure_reason: reason.slice(0, 60) });
    await logAudit(
      {
        userId: actor.id,
        action: 'PHOTO_UPLOAD_FAILED',
        entityType: 'job_photo',
        entityId: id,
        newValue: { reason: reason.slice(0, 60) },
        ...meta,
      },
      trx,
    );
  });
}

/** Lists READY photos (the only ones that are real evidence). */
export async function listStepPhotos(actor: AuthUser, jobId: number, jobStepId: number): Promise<PhotoDetail[]> {
  await loadScopedJob(actor, jobId);
  const rows = await db('job_photos')
    .select('job_photos.*', 'users.first_name', 'users.last_name')
    .join('users', 'users.id', 'job_photos.created_by')
    .where({ 'job_photos.job_id': jobId, 'job_photos.job_step_id': jobStepId, 'job_photos.status': 'READY' })
    .orderBy('job_photos.id');
  return rows.map((row: Record<string, any>) => ({
    id: row.id,
    attempt: row.attempt,
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    uploadedByName: `${row.first_name} ${row.last_name}`,
    createdAt: row.created_at,
  }));
}

/** Streams a READY photo's bytes — same job authorization as any job read. */
export async function getPhotoStream(
  actor: AuthUser,
  jobId: number,
  jobStepId: number,
  photoId: number,
): Promise<{ stream: Readable; mimeType: string; sizeBytes: number }> {
  await loadScopedJob(actor, jobId);
  const photo = await db('job_photos')
    .where({ id: photoId, job_id: jobId, job_step_id: jobStepId, status: 'READY' })
    .first();
  if (!photo) throw ApiError.notFound('Rasm topilmadi');
  try {
    const stream = await getStorageProvider().getStream(photo.storage_key);
    return { stream, mimeType: photo.mime_type, sizeBytes: photo.size_bytes };
  } catch (err) {
    if (err instanceof StorageError && err.kind === 'NOT_FOUND') {
      throw ApiError.notFound('Rasm topilmadi');
    }
    throw err;
  }
}
