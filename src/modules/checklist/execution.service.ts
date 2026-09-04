import { db } from '../../config/database';
import { ApiError } from '../../utils/errors';
import { logAudit } from '../audit/audit.service';
import { jobsBranchScope } from '../../rbac/permissions';
import { canExecuteJob } from '../jobs/assignment.service';
import { isWorkable, workingStatus } from '../jobs/job-cycle';
import { loadStepsWithMeasurements, type StepDetail } from './templates.service';
import type { AuthUser } from '../../types/auth';

interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

/**
 * PENDING → COMPLETED for normal steps.
 * PENDING → WAITING_APPROVAL → APPROVED | REJECTED for STOP steps (§17).
 */
export type JobStepStatus = 'PENDING' | 'COMPLETED' | 'WAITING_APPROVAL' | 'APPROVED' | 'REJECTED';

/** Statuses that satisfy the §15 sequence (later steps may proceed). */
export const STEP_DONE_STATUSES: JobStepStatus[] = ['COMPLETED', 'APPROVED'];

export interface SubmittedMeasurement {
  measurementId: number;
  value: number;
}

export interface StepStopApprovalInfo {
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  attempt: number;
  submittedByName: string;
  submittedAt: Date;
  decidedByName: string | null;
  decidedAt: Date | null;
  rejectReason: string | null;
}

export interface StepPhotoInfo {
  id: number;
  attempt: number;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedByName: string;
  createdAt: Date;
}

export interface JobStepView {
  /** job_steps.id — the execution row the client completes. */
  id: number;
  templateStepId: number;
  sortOrder: number;
  name: string;
  description: string | null;
  requirements: string | null;
  isStop: boolean;
  riskWeight: number;
  requiredPhotos: number;
  measurements: (StepDetail['measurements'][number] & {
    submittedValue: number | null;
    isWithinRange: boolean | null;
  })[];
  status: JobStepStatus;
  note: string | null;
  completedByName: string | null;
  completedAt: Date | null;
  /** Server-derived: exactly one step is current at a time. */
  isCurrent: boolean;
  /** Latest STOP approval record for this step (STOP steps only). */
  stopApproval: StepStopApprovalInfo | null;
  /** Correction cycle currently in progress (or covered by the latest decision). */
  currentAttempt: number;
  /** All evidence photos across attempts (immutable, add-only). */
  photos: StepPhotoInfo[];
  /** Photo requirement progress for the CURRENT attempt (need = template rule). */
  photoProgress: { have: number; need: number };
}

export interface JobChecklistView {
  id: number;
  templateName: string;
  version: number;
  assignedAt: Date;
  completedAt: Date | null;
  progress: { completed: number; total: number };
  currentStepId: number | null;
  steps: JobStepView[];
}

/**
 * Loads a job with branch-scope enforcement (404 out of scope — consistent
 * with the jobs module so ids cannot be probed across branches).
 */
async function loadScopedJob(actor: AuthUser, jobId: number) {
  const scope = jobsBranchScope(actor);
  const job = await db('jobs').where({ id: jobId }).first();
  if (!job || (scope !== null && job.branch_id !== scope)) {
    throw ApiError.notFound('Ish topilmadi');
  }
  return job;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function getJobChecklist(actor: AuthUser, jobId: number): Promise<JobChecklistView | null> {
  await loadScopedJob(actor, jobId);

  const checklist = await db('job_checklists')
    .select(
      'job_checklists.*',
      'checklist_template_versions.version',
      'checklist_templates.name as template_name',
    )
    .join('checklist_template_versions', 'checklist_template_versions.id', 'job_checklists.version_id')
    .join('checklist_templates', 'checklist_templates.id', 'checklist_template_versions.template_id')
    .where('job_checklists.job_id', jobId)
    .first();
  if (!checklist) return null;

  const templateSteps = (await loadStepsWithMeasurements([checklist.version_id])).get(checklist.version_id) ?? [];

  const executionRows = await db('job_steps')
    .select('job_steps.*', 'users.first_name', 'users.last_name')
    .leftJoin('users', 'users.id', 'job_steps.completed_by')
    .where('job_steps.job_checklist_id', checklist.id);
  const executionByStep = new Map<number, (typeof executionRows)[number]>(
    executionRows.map((r: { step_id: number }) => [r.step_id, r]),
  );

  const jobStepIds = executionRows.map((r: { id: number }) => r.id);
  // Latest-attempt value per (step, measurement) — earlier attempts stay in
  // the table as history but the view shows the current evidence.
  const values =
    jobStepIds.length > 0
      ? await db('step_measurements').whereIn('job_step_id', jobStepIds).orderBy('attempt', 'desc')
      : [];
  const valueByKey = new Map<string, { value: unknown; is_within_range: number }>();
  for (const v of values) {
    const key = `${v.job_step_id}:${v.measurement_id}`;
    if (!valueByKey.has(key)) valueByKey.set(key, v as never);
  }

  const photos =
    jobStepIds.length > 0
      ? await db('job_photos')
          .select('job_photos.*', 'users.first_name', 'users.last_name')
          .join('users', 'users.id', 'job_photos.created_by')
          .whereIn('job_photos.job_step_id', jobStepIds)
          .orderBy('job_photos.id')
      : [];
  const photosByStep = new Map<number, StepPhotoInfo[]>();
  for (const p of photos) {
    const list = photosByStep.get(p.job_step_id) ?? [];
    list.push({
      id: p.id,
      attempt: p.attempt,
      originalName: p.original_name,
      mimeType: p.mime_type,
      sizeBytes: p.size_bytes,
      uploadedByName: `${p.first_name} ${p.last_name}`,
      createdAt: p.created_at,
    });
    photosByStep.set(p.job_step_id, list);
  }


  // Latest STOP approval record per step (ordered desc → first seen wins).
  const approvals =
    jobStepIds.length > 0
      ? await db('stop_approvals')
          .select(
            'stop_approvals.*',
            'submitter.first_name as sub_first',
            'submitter.last_name as sub_last',
            'decider.first_name as dec_first',
            'decider.last_name as dec_last',
          )
          .join('users as submitter', 'submitter.id', 'stop_approvals.submitted_by')
          .leftJoin('users as decider', 'decider.id', 'stop_approvals.decided_by')
          .whereIn('stop_approvals.job_step_id', jobStepIds)
          .orderBy('stop_approvals.id', 'desc')
      : [];
  const approvalByStep = new Map<number, StepStopApprovalInfo>();
  for (const a of approvals) {
    if (!approvalByStep.has(a.job_step_id)) {
      approvalByStep.set(a.job_step_id, {
        status: a.status,
        attempt: a.attempt,
        submittedByName: `${a.sub_first} ${a.sub_last}`,
        submittedAt: a.submitted_at,
        decidedByName: a.dec_first ? `${a.dec_first} ${a.dec_last}` : null,
        decidedAt: a.decided_at,
        rejectReason: a.reject_reason,
      });
    }
  }

  let currentAssigned = false;
  let completed = 0;
  const steps: JobStepView[] = templateSteps.map((ts) => {
    const exec = executionByStep.get(ts.id);
    const status = (exec?.status ?? 'PENDING') as JobStepStatus;
    if (STEP_DONE_STATUSES.includes(status)) completed += 1;
    const isCurrent = !currentAssigned && !STEP_DONE_STATUSES.includes(status);
    if (isCurrent) currentAssigned = true;

    // Attempt is a first-class execution column since Phase 9 (§24 correction).
    const currentAttempt = exec?.attempt ?? 1;
    const stepPhotos = exec ? photosByStep.get(exec.id) ?? [] : [];
    const currentAttemptPhotos = stepPhotos.filter((p) => p.attempt === currentAttempt).length;
    return {
      id: exec?.id ?? 0,
      templateStepId: ts.id,
      sortOrder: ts.sortOrder,
      name: ts.name,
      description: ts.description,
      requirements: ts.requirements,
      isStop: ts.isStop,
      riskWeight: ts.riskWeight,
      requiredPhotos: ts.requiredPhotos,
      measurements: ts.measurements.map((m) => {
        const submitted = exec ? valueByKey.get(`${exec.id}:${m.id}`) : undefined;
        return {
          ...m,
          submittedValue: submitted ? Number(submitted.value) : null,
          isWithinRange: submitted ? Boolean(submitted.is_within_range) : null,
        };
      }),
      status,
      note: exec?.note ?? null,
      completedByName: exec?.first_name ? `${exec.first_name} ${exec.last_name}` : null,
      completedAt: exec?.completed_at ?? null,
      isCurrent,
      stopApproval: exec ? approvalByStep.get(exec.id) ?? null : null,
      currentAttempt,
      photos: stepPhotos,
      photoProgress: { have: currentAttemptPhotos, need: ts.requiredPhotos },
    };
  });

  return {
    id: checklist.id,
    templateName: checklist.template_name,
    version: checklist.version,
    assignedAt: checklist.assigned_at,
    completedAt: checklist.completed_at,
    progress: { completed, total: steps.length },
    currentStepId: steps.find((s) => s.isCurrent)?.id ?? null,
    steps,
  };
}

// ---------------------------------------------------------------------------
// Assignment — snapshots the CURRENT PUBLISHED version (server-resolved)
// ---------------------------------------------------------------------------

export async function assignChecklist(
  actor: AuthUser,
  jobId: number,
  templateId: number,
  meta: RequestMeta,
): Promise<JobChecklistView> {
  await loadScopedJob(actor, jobId); // visibility (404 out of scope)

  await db.transaction(async (trx) => {
    // Phase 10A: the job is locked and its state RE-validated inside the
    // transaction (standard lock order: job row → checklist header) — a
    // concurrent cancel can no longer slip a checklist onto a cancelled job,
    // and concurrent assigns serialize on this lock instead of racing the
    // unique key into a 500.
    const job = await trx('jobs').where({ id: jobId }).forUpdate().first();
    if (!job || (job.status !== 'DRAFT' && job.status !== 'IN_PROGRESS')) {
      throw ApiError.conflict("Bu holatdagi ishga checklist biriktirib bo'lmaydi", 'JOB_STATE_INVALID');
    }

    const existing = await trx('job_checklists').where({ job_id: jobId }).forUpdate().first();
    if (existing) {
      throw ApiError.conflict('Bu ishga checklist allaqachon biriktirilgan', 'CHECKLIST_EXISTS');
    }

    // The version is ALWAYS the template's current PUBLISHED one — the client
    // can only pick a template, never a version (§41).
    const version = await trx('checklist_template_versions')
      .where({ template_id: templateId, status: 'PUBLISHED' })
      .first();
    if (!version) {
      throw ApiError.badRequest("Bu shablonning faol (nashr qilingan) versiyasi yo'q", 'NO_PUBLISHED_VERSION');
    }

    const steps = await trx('checklist_steps').where({ version_id: version.id }).orderBy('sort_order');
    if (steps.length === 0) {
      throw ApiError.conflict("Versiyada bosqichlar yo'q", 'EMPTY_VERSION');
    }

    const [checklistId] = await trx('job_checklists').insert({
      job_id: jobId,
      version_id: version.id,
      assigned_by: actor.id,
    });

    // Pre-create every execution row (PENDING) so progress and locking are
    // simple row updates — no partially-created structures.
    for (const step of steps) {
      await trx('job_steps').insert({
        job_checklist_id: checklistId,
        step_id: step.id,
        status: 'PENDING',
      });
    }

    await logAudit(
      {
        userId: actor.id,
        action: 'CHECKLIST_ASSIGNED',
        entityType: 'job',
        entityId: jobId,
        newValue: { templateId, versionId: version.id, version: version.version, stepCount: steps.length },
        ...meta,
      },
      trx,
    );
  });

  return (await getJobChecklist(actor, jobId))!;
}

// ---------------------------------------------------------------------------
// Sequential completion (§15) with measurement validation (§16)
// ---------------------------------------------------------------------------

/** Decimal-safe inclusive range check: compares integer thousandths, never raw floats. */
function toThousandths(v: number): number {
  return Math.round(v * 1000);
}

export async function completeStep(
  actor: AuthUser,
  jobId: number,
  jobStepId: number,
  input: { note?: string | null; measurements: SubmittedMeasurement[] },
  meta: RequestMeta,
): Promise<JobChecklistView> {
  await loadScopedJob(actor, jobId); // visibility (404 out of scope)

  await db.transaction(async (trx) => {
    // Lock order everywhere: job row → checklist header. The job lock also
    // serializes against STOP approve/reject which locks the job row first.
    const job = await trx('jobs').where({ id: jobId }).forUpdate().first();
    // §24: REOPENED is the working state of a reopen-correction cycle.
    if (!job || !isWorkable(job)) {
      throw ApiError.conflict("Bosqichni bajarish uchun ish ish jarayonida bo'lishi kerak", 'JOB_NOT_IN_PROGRESS');
    }
    // Phase 10D responsibility: only the ASSIGNED technician (or a supervising
    // MASTER) may perform restricted checklist work — a same-branch USTA cannot
    // take another technician's assigned job.
    if (!canExecuteJob(actor, job)) {
      throw ApiError.forbidden('Bu ish sizga biriktirilmagan');
    }

    // Locking the checklist header serializes ALL step completions for this
    // job — two concurrent requests cannot both pass the sequence check.
    const checklist = await trx('job_checklists').where({ job_id: jobId }).forUpdate().first();
    if (!checklist) throw ApiError.notFound('Bu ishga checklist biriktirilmagan');

    const jobStep = await trx('job_steps')
      .select(
        'job_steps.*',
        'checklist_steps.sort_order',
        'checklist_steps.name as step_name',
        'checklist_steps.is_stop',
        'checklist_steps.required_photos',
      )
      .join('checklist_steps', 'checklist_steps.id', 'job_steps.step_id')
      .where('job_steps.id', jobStepId)
      .where('job_steps.job_checklist_id', checklist.id)
      .first();
    if (!jobStep) throw ApiError.notFound('Bosqich topilmadi');

    if (jobStep.status !== 'PENDING') {
      throw ApiError.conflict('Bu bosqich allaqachon bajarilgan', 'STEP_ALREADY_COMPLETED');
    }

    // Attempt is the execution row's own counter (incremented by STOP rework
    // and §24 step redo). Server-derived, never client input.
    const attempt = jobStep.attempt as number;

    // §19 photo enforcement: the requirement counts REAL photo records of the
    // CURRENT attempt — a rejected attempt's evidence cannot satisfy the
    // corrected attempt, and no client-sent counter is ever trusted.
    if (jobStep.required_photos > 0) {
      // Phase 10B: only READY evidence counts — PENDING/FAILED uploads never
      // satisfy the requirement.
      const [{ c: photoCount }] = (await trx('job_photos')
        .where({ job_step_id: jobStep.id, attempt, status: 'READY' })
        .count({ c: '*' })) as [{ c: number | string }];
      if (Number(photoCount) < jobStep.required_photos) {
        throw new ApiError(422, 'PHOTOS_REQUIRED', "Bosqich uchun kerakli foto dalillar yetarli emas", [
          {
            field: 'photos',
            message: `Kerakli rasmlar: ${photoCount}/${jobStep.required_photos} — yana ${
              jobStep.required_photos - Number(photoCount)
            } ta rasm yuklang`,
          },
        ]);
      }
    }

    // §15 sequence: every earlier step must be done (COMPLETED or APPROVED STOP).
    const incompleteBefore = await trx('job_steps')
      .join('checklist_steps', 'checklist_steps.id', 'job_steps.step_id')
      .where('job_steps.job_checklist_id', checklist.id)
      .where('checklist_steps.sort_order', '<', jobStep.sort_order)
      .whereNotIn('job_steps.status', STEP_DONE_STATUSES)
      .first();
    if (incompleteBefore) {
      throw ApiError.conflict('Avvalgi bosqich hali bajarilmagan', 'PREVIOUS_STEP_INCOMPLETE');
    }

    // §16 measurement validation against the template's definitions.
    const defs = await trx('checklist_step_measurements').where({ step_id: jobStep.step_id });
    const submittedById = new Map(input.measurements.map((m) => [m.measurementId, m.value]));

    const validationErrors: { field: string; message: string }[] = [];
    const toStore: { measurement_id: number; value: number; is_within_range: boolean }[] = [];

    for (const def of defs) {
      const value = submittedById.get(def.id);
      if (value === undefined) {
        if (def.required) {
          validationErrors.push({ field: def.name, message: `"${def.name}" o'lchovi kiritilishi shart` });
        }
        continue;
      }
      const v = toThousandths(value);
      const min = def.min_value != null ? toThousandths(Number(def.min_value)) : null;
      const max = def.max_value != null ? toThousandths(Number(def.max_value)) : null;
      const withinRange = (min === null || v >= min) && (max === null || v <= max);
      if (!withinRange) {
        const range = [
          def.min_value != null ? `min ${Number(def.min_value)}` : null,
          def.max_value != null ? `max ${Number(def.max_value)}` : null,
        ]
          .filter(Boolean)
          .join(', ');
        validationErrors.push({
          field: def.name,
          message: `"${def.name}" qiymati chegaradan tashqarida (${range} ${def.unit})`,
        });
        continue;
      }
      toStore.push({ measurement_id: def.id, value, is_within_range: true });
    }

    // Submitted ids that don't belong to this step are rejected outright.
    const defIds = new Set(defs.map((d: { id: number }) => d.id));
    for (const m of input.measurements) {
      if (!defIds.has(m.measurementId)) {
        throw ApiError.badRequest("Noto'g'ri o'lchov identifikatori", 'INVALID_MEASUREMENT');
      }
    }

    if (validationErrors.length > 0) {
      throw new ApiError(422, 'OUT_OF_RANGE', "O'lchov qiymatlari talabga javob bermaydi", validationErrors);
    }

    for (const row of toStore) {
      await trx('step_measurements').insert({
        job_step_id: jobStep.id,
        measurement_id: row.measurement_id,
        value: row.value,
        is_within_range: row.is_within_range,
        attempt,
      });
    }

    if (jobStep.is_stop) {
      // §17: a STOP step never completes on its own — the technician's result
      // is stored, the step waits for a Master decision, and the whole job
      // moves to WAITING_STOP_APPROVAL (blocking all further checklist work).
      await trx('job_steps').where({ id: jobStep.id }).update({
        status: 'WAITING_APPROVAL',
        note: input.note ?? null,
        completed_by: actor.id,
        completed_at: trx.fn.now(),
        updated_at: trx.fn.now(),
      });

      await trx('stop_approvals').insert({
        job_id: jobId,
        job_step_id: jobStep.id,
        status: 'PENDING',
        submitted_by: actor.id,
        attempt,
      });

      await trx('jobs').where({ id: jobId }).update({ status: 'WAITING_STOP_APPROVAL', updated_at: trx.fn.now() });

      await logAudit(
        {
          userId: actor.id,
          action: 'STOP_SUBMITTED',
          entityType: 'job_step',
          entityId: jobStep.id,
          oldValue: { jobStatus: job.status, stepStatus: 'PENDING' },
          newValue: {
            jobId,
            step: jobStep.step_name,
            sortOrder: jobStep.sort_order,
            jobStatus: 'WAITING_STOP_APPROVAL',
            stepStatus: 'WAITING_APPROVAL',
            attempt,
            note: input.note ?? null,
            measurements: toStore.map((m) => ({ id: m.measurement_id, value: m.value })),
          },
          ...meta,
        },
        trx,
      );
      return;
    }

    await trx('job_steps').where({ id: jobStep.id }).update({
      status: 'COMPLETED',
      note: input.note ?? null,
      completed_by: actor.id,
      completed_at: trx.fn.now(),
      updated_at: trx.fn.now(),
    });

    // If that was the last open step, the checklist itself is complete.
    const remaining = await trx('job_steps')
      .where({ job_checklist_id: checklist.id })
      .whereNotIn('status', STEP_DONE_STATUSES)
      .first();
    if (!remaining) {
      await trx('job_checklists').where({ id: checklist.id }).update({ completed_at: trx.fn.now(), updated_at: trx.fn.now() });
    }

    await logAudit(
      {
        userId: actor.id,
        action: 'STEP_COMPLETED',
        entityType: 'job_step',
        entityId: jobStep.id,
        newValue: {
          jobId,
          step: jobStep.step_name,
          sortOrder: jobStep.sort_order,
          measurements: toStore.map((m) => ({ id: m.measurement_id, value: m.value })),
          checklistCompleted: !remaining,
        },
        ...meta,
      },
      trx,
    );
  });

  return (await getJobChecklist(actor, jobId))!;
}

/**
 * §24 correction: during an active REOPENED cycle a done step (COMPLETED or
 * APPROVED) may be re-opened as a NEW attempt for corrective rework.
 * Historical results/evidence of earlier attempts are untouched; the redone
 * step needs fresh measurements/photos and — for STOP steps — a fresh Master
 * decision through the unchanged Phase 6/7 flow.
 */
export async function redoStep(
  actor: AuthUser,
  jobId: number,
  jobStepId: number,
  meta: RequestMeta,
): Promise<JobChecklistView> {
  await loadScopedJob(actor, jobId);

  await db.transaction(async (trx) => {
    const job = await trx('jobs').where({ id: jobId }).forUpdate().first();
    if (!job || job.status !== 'REOPENED') {
      throw ApiError.conflict("Bosqichni qayta bajarish faqat qayta ochilgan ishda mumkin", 'JOB_NOT_REOPENED');
    }

    const checklist = await trx('job_checklists').where({ job_id: jobId }).forUpdate().first();
    if (!checklist) throw ApiError.notFound('Bu ishga checklist biriktirilmagan');

    const jobStep = await trx('job_steps')
      .select('job_steps.*', 'checklist_steps.name as step_name', 'checklist_steps.sort_order')
      .join('checklist_steps', 'checklist_steps.id', 'job_steps.step_id')
      .where('job_steps.id', jobStepId)
      .where('job_steps.job_checklist_id', checklist.id)
      .forUpdate()
      .first();
    if (!jobStep) throw ApiError.notFound('Bosqich topilmadi');
    if (!STEP_DONE_STATUSES.includes(jobStep.status)) {
      throw ApiError.conflict('Faqat bajarilgan bosqichni qayta ochish mumkin', 'STEP_NOT_DONE');
    }

    await trx('job_steps')
      .where({ id: jobStep.id })
      .update({ status: 'PENDING', attempt: jobStep.attempt + 1, updated_at: trx.fn.now() });
    // The checklist is no longer complete until the correction finishes.
    await trx('job_checklists').where({ id: checklist.id }).update({ completed_at: null, updated_at: trx.fn.now() });

    await logAudit(
      {
        userId: actor.id,
        action: 'STEP_CORRECTION_STARTED',
        entityType: 'job_step',
        entityId: jobStep.id,
        oldValue: { stepStatus: jobStep.status, attempt: jobStep.attempt },
        newValue: {
          jobId,
          step: jobStep.step_name,
          sortOrder: jobStep.sort_order,
          stepStatus: 'PENDING',
          attempt: jobStep.attempt + 1,
        },
        ...meta,
      },
      trx,
    );
  });

  return (await getJobChecklist(actor, jobId))!;
}
