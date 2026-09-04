import type { Knex } from 'knex';
import { db } from '../../config/database';
import { ApiError } from '../../utils/errors';
import { logAudit } from '../audit/audit.service';
import { jobsBranchScope } from '../../rbac/permissions';
import { workingStatus } from '../jobs/job-cycle';
import { STEP_DONE_STATUSES } from './execution.service';
import { linkStopRejectionRisk, resolveStopRisk } from '../risk/risk.service';
import type { AuthUser } from '../../types/auth';

interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export interface StopApprovalRecord {
  id: number;
  jobStepId: number;
  stepName: string;
  stepSortOrder: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  attempt: number;
  submittedByName: string;
  submittedAt: Date;
  decidedByName: string | null;
  decidedAt: Date | null;
  rejectReason: string | null;
}

/**
 * STOP history for a job (jobs.view + §11 branch scope; 404 out of scope).
 * Records are historical — never mutated after decision, never deleted.
 */
export async function getJobStopApprovals(actor: AuthUser, jobId: number): Promise<StopApprovalRecord[]> {
  const scope = jobsBranchScope(actor);
  const job = await db('jobs').where({ id: jobId }).first();
  if (!job || (scope !== null && job.branch_id !== scope)) {
    throw ApiError.notFound('Ish topilmadi');
  }

  const rows = await db('stop_approvals')
    .select(
      'stop_approvals.*',
      'checklist_steps.name as step_name',
      'checklist_steps.sort_order as step_sort_order',
      'submitter.first_name as sub_first',
      'submitter.last_name as sub_last',
      'decider.first_name as dec_first',
      'decider.last_name as dec_last',
    )
    .join('job_steps', 'job_steps.id', 'stop_approvals.job_step_id')
    .join('checklist_steps', 'checklist_steps.id', 'job_steps.step_id')
    .join('users as submitter', 'submitter.id', 'stop_approvals.submitted_by')
    .leftJoin('users as decider', 'decider.id', 'stop_approvals.decided_by')
    .where('stop_approvals.job_id', jobId)
    .orderBy('stop_approvals.id', 'desc');

  return rows.map((r: Record<string, any>) => ({
    id: r.id,
    jobStepId: r.job_step_id,
    stepName: r.step_name,
    stepSortOrder: r.step_sort_order,
    status: r.status,
    attempt: r.attempt,
    submittedByName: `${r.sub_first} ${r.sub_last}`,
    submittedAt: r.submitted_at,
    decidedByName: r.dec_first ? `${r.dec_first} ${r.dec_last}` : null,
    decidedAt: r.decided_at,
    rejectReason: r.reject_reason,
  }));
}

/**
 * §18 approval chain, shared by approve and reject:
 * 1-2. session + active user (requireAuth) 3. permission (requirePermission)
 * 4. job access (branch scope, 404) 5-7. job is WAITING_STOP_APPROVAL and the
 * PENDING approval + WAITING_APPROVAL step exist 8. transaction with row locks
 * (job first — same order as completeStep, so decisions and completions
 * serialize) 9-10. decision + audit atomically 12. commit.
 * (§18 step 11, notification, is deferred to the notifications phase.)
 */
async function lockPendingStop(trx: Knex.Transaction, actor: AuthUser, jobId: number) {
  const scope = jobsBranchScope(actor);
  const job = await trx('jobs').where({ id: jobId }).forUpdate().first();
  if (!job || (scope !== null && job.branch_id !== scope)) {
    throw ApiError.notFound('Ish topilmadi');
  }
  if (job.status !== 'WAITING_STOP_APPROVAL') {
    throw ApiError.conflict('Bu ish STOP tasdig\'ini kutmayapti', 'JOB_NOT_WAITING_STOP');
  }

  const approval = await trx('stop_approvals').where({ job_id: jobId, status: 'PENDING' }).forUpdate().first();
  if (!approval) {
    throw ApiError.conflict("Kutilayotgan STOP so'rovi topilmadi", 'NO_PENDING_STOP');
  }

  const step = await trx('job_steps')
    .select('job_steps.*', 'checklist_steps.name as step_name', 'checklist_steps.sort_order')
    .join('checklist_steps', 'checklist_steps.id', 'job_steps.step_id')
    .where('job_steps.id', approval.job_step_id)
    .forUpdate()
    .first();
  if (!step || step.status !== 'WAITING_APPROVAL') {
    throw ApiError.conflict("STOP bosqichi tasdiq kutish holatida emas", 'STOP_STEP_STATE_INVALID');
  }

  return { job, approval, step };
}

/** Master approves: step → APPROVED, job → IN_PROGRESS, next step unlocks (§15). */
export async function approveStop(actor: AuthUser, jobId: number, meta: RequestMeta): Promise<void> {
  await db.transaction(async (trx) => {
    const { job, approval, step } = await lockPendingStop(trx, actor, jobId);
    // §24: inside a reopened correction cycle work returns to REOPENED.
    const nextStatus = workingStatus(job);

    // Phase 10D (§17/§21): an approved STOP is the accepted mitigation — resolve
    // the blocking risk auto-linked when this STOP step was rejected, in the SAME
    // transaction (no recursion into the risk routes).
    await resolveStopRisk(
      trx,
      { jobId, cycle: job.cycle ?? 1, jobStepId: step.id, actorId: actor.id, stopApprovalId: approval.id },
      meta,
    );

    // decided_by/decided_at are server-controlled — never client-supplied.
    await trx('stop_approvals')
      .where({ id: approval.id })
      .update({ status: 'APPROVED', decided_by: actor.id, decided_at: trx.fn.now(), updated_at: trx.fn.now() });
    await trx('job_steps').where({ id: step.id }).update({ status: 'APPROVED', updated_at: trx.fn.now() });
    await trx('jobs').where({ id: jobId }).update({ status: nextStatus, updated_at: trx.fn.now() });

    // If the STOP step was the last one, the checklist is now complete.
    const remaining = await trx('job_steps')
      .where({ job_checklist_id: step.job_checklist_id })
      .whereNotIn('status', STEP_DONE_STATUSES)
      .first();
    if (!remaining) {
      await trx('job_checklists')
        .where({ id: step.job_checklist_id })
        .update({ completed_at: trx.fn.now(), updated_at: trx.fn.now() });
    }

    await logAudit(
      {
        userId: actor.id,
        action: 'STOP_APPROVED',
        entityType: 'stop_approval',
        entityId: approval.id,
        oldValue: { jobStatus: 'WAITING_STOP_APPROVAL', stepStatus: 'WAITING_APPROVAL' },
        newValue: {
          jobId,
          step: step.step_name,
          sortOrder: step.sort_order,
          jobStatus: nextStatus,
          stepStatus: 'APPROVED',
          checklistCompleted: !remaining,
        },
        ...meta,
      },
      trx,
    );
  });
}

/**
 * §3 correction/rework: the technician starts fixing a rejected STOP.
 * Controlled transition — job REJECTED → IN_PROGRESS, rejected step → PENDING
 * (it becomes the current step again). The historical decision record, the
 * rejected attempt's measurements and its photos are all preserved untouched.
 * Resubmission then flows through the normal completion path, creating a NEW
 * stop_approvals record (next attempt) that requires a fresh Master decision.
 */
export async function reworkStop(actor: AuthUser, jobId: number, meta: RequestMeta): Promise<void> {
  await db.transaction(async (trx) => {
    const scope = jobsBranchScope(actor);
    const job = await trx('jobs').where({ id: jobId }).forUpdate().first();
    if (!job || (scope !== null && job.branch_id !== scope)) {
      throw ApiError.notFound('Ish topilmadi');
    }
    if (job.status !== 'REJECTED') {
      throw ApiError.conflict('Faqat rad etilgan (REJECTED) ishni tuzatish mumkin', 'JOB_NOT_REJECTED');
    }

    const checklist = await trx('job_checklists').where({ job_id: jobId }).forUpdate().first();
    if (!checklist) throw ApiError.conflict('Bu ishga checklist biriktirilmagan', 'NO_CHECKLIST');

    const step = await trx('job_steps')
      .select('job_steps.*', 'checklist_steps.name as step_name', 'checklist_steps.sort_order')
      .join('checklist_steps', 'checklist_steps.id', 'job_steps.step_id')
      .where('job_steps.job_checklist_id', checklist.id)
      .where('job_steps.status', 'REJECTED')
      .forUpdate()
      .first();
    if (!step) throw ApiError.conflict('Rad etilgan STOP bosqichi topilmadi', 'NO_REJECTED_STEP');

    const attemptCount = step.attempt as number;

    // Historical rows are untouched — only the live execution state resets.
    // §24: inside a reopened correction cycle work returns to REOPENED.
    await trx('job_steps')
      .where({ id: step.id })
      .update({ status: 'PENDING', attempt: step.attempt + 1, updated_at: trx.fn.now() });
    await trx('jobs').where({ id: jobId }).update({ status: workingStatus(job), updated_at: trx.fn.now() });

    await logAudit(
      {
        userId: actor.id,
        action: 'STOP_CORRECTION_STARTED',
        entityType: 'job_step',
        entityId: step.id,
        oldValue: { jobStatus: 'REJECTED', stepStatus: 'REJECTED' },
        newValue: {
          jobId,
          step: step.step_name,
          sortOrder: step.sort_order,
          jobStatus: workingStatus(job),
          stepStatus: 'PENDING',
          nextAttempt: Number(attemptCount) + 1,
        },
        ...meta,
      },
      trx,
    );
  });
}

/** Master rejects with a mandatory reason: step → REJECTED, job → REJECTED (§17). */
export async function rejectStop(actor: AuthUser, jobId: number, reason: string, meta: RequestMeta): Promise<void> {
  await db.transaction(async (trx) => {
    const { job, approval, step } = await lockPendingStop(trx, actor, jobId);

    await trx('stop_approvals').where({ id: approval.id }).update({
      status: 'REJECTED',
      decided_by: actor.id,
      decided_at: trx.fn.now(),
      reject_reason: reason,
      updated_at: trx.fn.now(),
    });
    await trx('job_steps').where({ id: step.id }).update({ status: 'REJECTED', updated_at: trx.fn.now() });
    // The technician's submitted result (job_steps.completed_by/note and
    // step_measurements rows) is intentionally preserved — history.
    await trx('jobs').where({ id: jobId }).update({ status: 'REJECTED', updated_at: trx.fn.now() });

    // Phase 10D (§17/§21): a rejected STOP safety checkpoint auto-creates a
    // BLOCKING (CRITICAL) risk for this cycle+step, deduplicated, in the SAME
    // transaction. It must then be resolved (STOP re-approved, or explicit
    // resolution) before the job can complete.
    await linkStopRejectionRisk(
      trx,
      { jobId, cycle: job.cycle ?? 1, jobStepId: step.id, attempt: step.attempt as number, actorId: actor.id, stepName: step.step_name, reason },
      meta,
    );

    await logAudit(
      {
        userId: actor.id,
        action: 'STOP_REJECTED',
        entityType: 'stop_approval',
        entityId: approval.id,
        oldValue: { jobStatus: 'WAITING_STOP_APPROVAL', stepStatus: 'WAITING_APPROVAL' },
        newValue: {
          jobId,
          step: step.step_name,
          sortOrder: step.sort_order,
          jobStatus: 'REJECTED',
          stepStatus: 'REJECTED',
          reason,
        },
        ...meta,
      },
      trx,
    );
  });
}
