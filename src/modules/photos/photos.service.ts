import crypto from 'node:crypto';
import { db } from '../../config/database';
import { ApiError } from '../../utils/errors';
import { logAudit } from '../audit/audit.service';
import { jobsBranchScope } from '../../rbac/permissions';
import { isWorkable } from '../jobs/job-cycle';
import { getStorageProvider } from '../../storage';
import type { AuthUser } from '../../types/auth';

interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // 10 MB (§34 upload size limits)
export const MAX_PHOTOS_PER_ATTEMPT = 10;

/**
 * Content sniffing — the client's MIME type and filename extension are never
 * trusted (§34 file type validation). Only real JPEG/PNG/WebP bytes pass.
 */
export function detectImageType(buffer: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP')
    return 'image/webp';
  return null;
}

const EXT_BY_MIME: Record<string, string> = {
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

/**
 * Uploads one photo for the current attempt of a PENDING step.
 * Evidence freezes at submission: uploads to WAITING/decided/completed steps
 * are refused, so a submitted attempt's photo set can never change afterwards.
 */
export async function uploadStepPhoto(
  actor: AuthUser,
  jobId: number,
  jobStepId: number,
  file: { buffer: Buffer; originalname: string },
  meta: RequestMeta,
): Promise<PhotoDetail> {
  const job = await loadScopedJob(actor, jobId);
  // §24: REOPENED correction cycles may also collect fresh evidence.
  if (!isWorkable(job)) {
    throw ApiError.conflict("Foto yuklash uchun ish ish jarayonida bo'lishi kerak", 'JOB_NOT_IN_PROGRESS');
  }

  const mime = detectImageType(file.buffer);
  if (!mime) {
    throw new ApiError(422, 'INVALID_FILE_TYPE', 'Faqat JPEG, PNG yoki WebP rasm fayllari qabul qilinadi');
  }
  if (file.buffer.length > MAX_PHOTO_BYTES) {
    throw new ApiError(422, 'FILE_TOO_LARGE', 'Fayl juda katta (maksimum 10 MB)');
  }

  const hash = crypto.createHash('sha256').update(file.buffer).digest('hex');
  // Server-generated key — the client filename never touches storage paths.
  const storageKey = `photos/${jobId}/${jobStepId}/${crypto.randomUUID()}.${EXT_BY_MIME[mime]}`;

  const photoId = await db.transaction(async (trx) => {
    const checklist = await trx('job_checklists').where({ job_id: jobId }).first();
    if (!checklist) throw ApiError.notFound('Bu ishga checklist biriktirilmagan');

    // Row lock serializes concurrent uploads for the same step (count checks stay exact).
    const jobStep = await trx('job_steps')
      .where({ id: jobStepId, job_checklist_id: checklist.id })
      .forUpdate()
      .first();
    if (!jobStep) throw ApiError.notFound('Bosqich topilmadi');
    if (jobStep.status !== 'PENDING') {
      throw ApiError.conflict("Yuborilgan/yakunlangan bosqichga foto qo'shib bo'lmaydi", 'STEP_NOT_PENDING');
    }

    // Attempt is the execution row's own counter (Phase 9 §24 model).
    const attempt = jobStep.attempt as number;

    const [{ c: existing }] = (await trx('job_photos')
      .where({ job_step_id: jobStepId, attempt })
      .count({ c: '*' })) as [{ c: number | string }];
    if (Number(existing) >= MAX_PHOTOS_PER_ATTEMPT) {
      throw ApiError.conflict(`Bir urinish uchun ko'pi bilan ${MAX_PHOTOS_PER_ATTEMPT} ta rasm yuklash mumkin`, 'PHOTO_LIMIT');
    }

    const [newId] = await trx('job_photos').insert({
      job_id: jobId,
      job_step_id: jobStepId,
      attempt,
      storage_key: storageKey,
      original_name: file.originalname.slice(0, 255),
      mime_type: mime,
      size_bytes: file.buffer.length,
      hash,
      created_by: actor.id,
    });

    await logAudit(
      {
        userId: actor.id,
        action: 'PHOTO_UPLOADED',
        entityType: 'job_photo',
        entityId: newId,
        newValue: { jobId, jobStepId, attempt, mime, sizeBytes: file.buffer.length, hash },
        ...meta,
      },
      trx,
    );

    return newId as number;
  });

  try {
    await getStorageProvider().put(storageKey, file.buffer);
  } catch (err) {
    // Compensate: no metadata without bytes.
    await db('job_photos').where({ id: photoId }).del();
    throw err;
  }

  const row = await db('job_photos')
    .select('job_photos.*', 'users.first_name', 'users.last_name')
    .join('users', 'users.id', 'job_photos.created_by')
    .where('job_photos.id', photoId)
    .first();
  return {
    id: row.id,
    attempt: row.attempt,
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    uploadedByName: `${row.first_name} ${row.last_name}`,
    createdAt: row.created_at,
  };
}

export async function listStepPhotos(actor: AuthUser, jobId: number, jobStepId: number): Promise<PhotoDetail[]> {
  await loadScopedJob(actor, jobId);
  const rows = await db('job_photos')
    .select('job_photos.*', 'users.first_name', 'users.last_name')
    .join('users', 'users.id', 'job_photos.created_by')
    .where({ 'job_photos.job_id': jobId, 'job_photos.job_step_id': jobStepId })
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

/** Streams photo bytes — same job authorization as every other job read (404 out of scope). */
export async function getPhotoFile(
  actor: AuthUser,
  jobId: number,
  jobStepId: number,
  photoId: number,
): Promise<{ buffer: Buffer; mimeType: string }> {
  await loadScopedJob(actor, jobId);
  const photo = await db('job_photos').where({ id: photoId, job_id: jobId, job_step_id: jobStepId }).first();
  if (!photo) throw ApiError.notFound('Rasm topilmadi');
  const buffer = await getStorageProvider().get(photo.storage_key);
  return { buffer, mimeType: photo.mime_type };
}
