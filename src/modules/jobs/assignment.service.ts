import type { Knex } from 'knex';
import { db } from '../../config/database';
import { ApiError } from '../../utils/errors';
import { logAudit } from '../audit/audit.service';
import { can, jobsBranchScope } from '../../rbac/permissions';
import { safePage, safePageSize } from '../../utils/pagination';
import type { AuthUser, RoleCode } from '../../types/auth';

/**
 * Phase 10D job assignment & responsibility.
 *
 * Responsibility model:
 *  - responsible technician  — jobs.assigned_technician_id (current pointer)
 *  - actual step performer   — job_steps.completed_by (unchanged, per-step)
 *  - supervisor/approver     — STOP/close/quality actors (unchanged)
 *
 * A new job auto-assigns its creator (SELF_AT_CREATION) — a USTA/MASTER opens a
 * job to perform it (§13). Reassignment requires `jobs.assign` (MASTER/ADMIN),
 * targets an ACTIVE user with an operational role in the job's branch (a global
 * ADMIN/SIFAT target needs an audited override reason), is refused on a terminal
 * job, is deterministic under concurrency (job row lock), and every change is an
 * immutable history row + audit. created_by is never assumed to be the assignee.
 */

interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

const ASSIGNABLE_ROLES: readonly RoleCode[] = ['USTA', 'MASTER'];
const TERMINAL = ['COMPLETED', 'CANCELLED'];

/** Records the creator as the responsible technician, inside the creation tx. */
export async function assignAtCreation(trx: Knex.Transaction, jobId: number, creator: AuthUser, cycle: number): Promise<void> {
  if (!ASSIGNABLE_ROLES.includes(creator.role)) return; // e.g. an admin-created job stays UNASSIGNED
  await trx('jobs').where({ id: jobId }).update({ assigned_technician_id: creator.id, assignment_status: 'ASSIGNED' });
  await trx('job_assignments').insert({ job_id: jobId, cycle, technician_id: creator.id, assigned_by: creator.id, provenance: 'SELF_AT_CREATION' });
}

async function loadJobLocked(actor: AuthUser, jobId: number, trx: Knex.Transaction) {
  const scope = jobsBranchScope(actor);
  const job = await trx('jobs').where({ id: jobId }).forUpdate().first();
  if (!job || (scope !== null && job.branch_id !== scope)) throw ApiError.notFound('Ish topilmadi');
  return job;
}

export async function reassign(actor: AuthUser, jobId: number, technicianId: number, reason: string | undefined, meta: RequestMeta): Promise<void> {
  if (!can(actor.role, 'jobs.assign')) throw ApiError.forbidden();

  await db.transaction(async (trx) => {
    const job = await loadJobLocked(actor, jobId, trx);
    if (TERMINAL.includes(job.status)) throw ApiError.conflict('Yakunlangan ishni qayta biriktirib bo\'lmaydi', 'JOB_TERMINAL');

    const target = await trx('users')
      .select('users.*', 'roles.code as role_code')
      .join('roles', 'roles.id', 'users.role_id')
      .leftJoin('branches', 'branches.id', 'users.branch_id')
      .where('users.id', technicianId)
      .whereNull('users.deleted_at')
      .first();
    if (!target) throw ApiError.badRequest('Texnik topilmadi', 'INVALID_TECHNICIAN');
    if (target.status !== 'ACTIVE') throw ApiError.conflict('Texnik faol emas', 'TECHNICIAN_INACTIVE');
    if (!ASSIGNABLE_ROLES.includes(target.role_code)) throw ApiError.badRequest('Bu rolni ishga biriktirib bo\'lmaydi', 'ROLE_NOT_ASSIGNABLE');
    // Must be in the job's branch (operational roles are branch-bound).
    if (target.branch_id !== job.branch_id) throw ApiError.conflict('Texnik ushbu filialga tegishli emas', 'CROSS_BRANCH_ASSIGNMENT');

    const prev = job.assigned_technician_id;
    await trx('jobs').where({ id: jobId }).update({ assigned_technician_id: technicianId, assignment_status: 'ASSIGNED', updated_at: trx.fn.now() });
    await trx('job_assignments').insert({ job_id: jobId, cycle: job.cycle ?? 1, technician_id: technicianId, assigned_by: actor.id, provenance: 'REASSIGNED', reason: reason ?? null });
    await logAudit(
      { userId: actor.id, action: 'JOB_REASSIGNED', entityType: 'job', entityId: jobId, oldValue: { technicianId: prev ?? null }, newValue: { technicianId, reason: reason ?? null }, ...meta },
      trx,
    );
  });
}

export async function unassign(actor: AuthUser, jobId: number, reason: string | undefined, meta: RequestMeta): Promise<void> {
  if (!can(actor.role, 'jobs.assign')) throw ApiError.forbidden();
  await db.transaction(async (trx) => {
    const job = await loadJobLocked(actor, jobId, trx);
    if (TERMINAL.includes(job.status)) throw ApiError.conflict('Yakunlangan ish', 'JOB_TERMINAL');
    const prev = job.assigned_technician_id;
    await trx('jobs').where({ id: jobId }).update({ assigned_technician_id: null, assignment_status: 'UNASSIGNED', updated_at: trx.fn.now() });
    await trx('job_assignments').insert({ job_id: jobId, cycle: job.cycle ?? 1, technician_id: null, assigned_by: actor.id, provenance: 'UNASSIGNED', reason: reason ?? null });
    await logAudit({ userId: actor.id, action: 'JOB_UNASSIGNED', entityType: 'job', entityId: jobId, oldValue: { technicianId: prev ?? null }, newValue: { technicianId: null, reason: reason ?? null }, ...meta }, trx);
  });
}

export async function getAssignmentHistory(actor: AuthUser, jobId: number): Promise<Array<{ id: number; technicianId: number | null; assignedBy: number; provenance: string; reason: string | null; createdAt: Date }>> {
  const scope = jobsBranchScope(actor);
  const job = await db('jobs').where({ id: jobId }).first();
  if (!job || (scope !== null && job.branch_id !== scope)) throw ApiError.notFound('Ish topilmadi');
  const rows = await db('job_assignments').where({ job_id: jobId }).orderBy('created_at', 'asc');
  return rows.map((r: Record<string, any>) => ({ id: r.id, technicianId: r.technician_id, assignedBy: r.assigned_by, provenance: r.provenance, reason: r.reason, createdAt: r.created_at }));
}

export async function listMyJobs(actor: AuthUser, opts: { page?: number; pageSize?: number } = {}): Promise<{ items: any[]; page: number; pageSize: number; total: number }> {
  // safePage/safePageSize (not `?? default`) so a NaN from Number('abc') can never
  // reach .offset() — nullish coalescing does not catch NaN.
  const page = safePage(opts.page);
  const pageSize = safePageSize(opts.pageSize);
  const q = db('jobs').where({ assigned_technician_id: actor.id });
  const [{ c }] = (await q.clone().count({ c: '*' })) as [{ c: number | string }];
  const rows = await q
    .clone()
    .join('vehicles', 'vehicles.id', 'jobs.vehicle_id')
    .join('customers', 'customers.id', 'jobs.customer_id')
    .orderBy('jobs.updated_at', 'desc')
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .select('jobs.id', 'jobs.status', 'jobs.cycle', 'jobs.assignment_status', 'vehicles.plate_number', 'customers.name as customer_name', 'jobs.created_at');
  return { items: rows, page, pageSize, total: Number(c) };
}

/**
 * Branch-scoped eligible assignment candidates (ACTIVE USTA/MASTER in the job's
 * branch). Needed so a `jobs.assign` holder can pick a technician WITHOUT the
 * broad `users.view` permission. Never exposes cross-branch users or PII beyond
 * name/role.
 */
export async function listCandidates(actor: AuthUser, jobId: number): Promise<Array<{ id: number; name: string; role: string }>> {
  if (!can(actor.role, 'jobs.assign')) throw ApiError.forbidden();
  const scope = jobsBranchScope(actor);
  const job = await db('jobs').where({ id: jobId }).first();
  if (!job || (scope !== null && job.branch_id !== scope)) throw ApiError.notFound('Ish topilmadi');
  const rows = await db('users')
    .join('roles', 'roles.id', 'users.role_id')
    .where('users.branch_id', job.branch_id)
    .where('users.status', 'ACTIVE')
    .whereNull('users.deleted_at')
    .whereIn('roles.code', ASSIGNABLE_ROLES as unknown as string[])
    .orderBy(['users.first_name', 'users.last_name'])
    .select('users.id', 'users.first_name', 'users.last_name', 'roles.code as role');
  return rows.map((r: Record<string, any>) => ({ id: r.id, name: `${r.first_name} ${r.last_name}`, role: r.role }));
}

/**
 * Phase 11C — the distinct RESPONSIBLE technicians that actually have jobs in the
 * caller's branch scope, for the completed-job list filter. This is HISTORICAL
 * filtering access, deliberately NOT the job-scoped assignment-eligibility list
 * (`listCandidates`): it is branch-scoped, name-searchable and bounded, and it
 * includes a technician even if now inactive (they still own historical jobs) — the
 * source is `jobs.assigned_technician_id`, never uploader/step-performer. `id`
 * resolves a single technician (to show the selected name after reload).
 */
export async function listResponsibleTechnicians(
  actor: AuthUser,
  opts: { search?: string; id?: number; limit?: number } = {},
): Promise<{ items: Array<{ id: number; name: string }>; total: number }> {
  const scope = jobsBranchScope(actor);
  const limit = Math.min(50, Math.max(1, opts.limit ?? 20));
  const build = () => {
    const q = db('jobs as j')
      .join('users as u', 'u.id', 'j.assigned_technician_id')
      .whereNotNull('j.assigned_technician_id');
    if (scope !== null) q.where('j.branch_id', scope);
    if (opts.id != null) q.where('u.id', opts.id);
    else if (opts.search) {
      const term = `%${opts.search.replace(/[%_]/g, '\\$&')}%`;
      q.where((sub) => sub.where('u.first_name', 'like', term).orWhere('u.last_name', 'like', term).orWhereRaw("CONCAT(u.first_name, ' ', u.last_name) like ?", [term]));
    }
    return q;
  };
  const countRows = (await build().countDistinct({ c: 'u.id' })) as unknown as [{ c: number | string }];
  const total = Number(countRows[0]?.c ?? 0);
  const rows = await build()
    .distinct('u.id', 'u.first_name', 'u.last_name')
    .orderBy(['u.first_name', 'u.last_name'])
    .limit(limit);
  return { items: rows.map((r: Record<string, any>) => ({ id: r.id, name: `${r.first_name} ${r.last_name}` })), total };
}

/**
 * Execution guard (test 13): who may perform restricted checklist work on a job.
 * The assigned technician may; a supervisor (MASTER) may; when the job is
 * unassigned/legacy, any same-branch checklist.execute holder may (back-compat).
 * A non-assigned USTA cannot take another technician's assigned job.
 */
export function canExecuteJob(actor: AuthUser, job: { assigned_technician_id: number | null; assignment_status: string }): boolean {
  if (actor.role === 'MASTER') return true; // service master supervises/performs
  if (job.assigned_technician_id == null) return true; // unassigned/legacy → branch-scoped fallback
  return job.assigned_technician_id === actor.id;
}
