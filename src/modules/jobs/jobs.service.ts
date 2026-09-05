import type { Knex } from 'knex';
import { db } from '../../config/database';
import { ApiError } from '../../utils/errors';
import { logAudit } from '../audit/audit.service';
import { jobsBranchScope } from '../../rbac/permissions';
import { assignAtCreation } from './assignment.service';
import { assertRiskPolicyApproved } from '../risk/risk-policy.service';
import type { AuthUser } from '../../types/auth';
import type { CreateJobInput, InstallationInput, JobStatus, ListJobsQuery } from './jobs.validators';

interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export interface JobDetail {
  id: number;
  status: JobStatus;
  customerId: number;
  customerName: string;
  customerPhone: string;
  vehicleId: number;
  plateNumber: string;
  vin: string | null;
  make: string;
  model: string;
  year: number | null;
  branchId: number;
  branchName: string;
  createdById: number;
  createdByName: string;
  createdAt: Date;
  startedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  cancelledByName: string | null;
  closedAt: Date | null;
  closedByName: string | null;
  reopenReason: string | null;
  reopenedAt: Date | null;
  reopenedByName: string | null;
  assignedTechnicianId: number | null;
  assignedTechnicianName: string | null;
  assignmentStatus: string;
  cycle: number;
  installation: {
    gasType: 'LPG' | 'CNG' | null;
    kit: string | null;
    ecu: string | null;
    cylinder: string | null;
    note: string | null;
  };
}

interface JobRow {
  id: number;
  status: JobStatus;
  customer_id: number;
  customer_name: string;
  customer_phone: string;
  vehicle_id: number;
  plate_number: string;
  vin: string | null;
  make: string;
  model: string;
  year: number | null;
  branch_id: number;
  branch_name: string;
  created_by: number;
  creator_first_name: string;
  creator_last_name: string;
  created_at: Date;
  started_at: Date | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  canceller_first_name: string | null;
  canceller_last_name: string | null;
  closed_at: Date | null;
  closer_first_name: string | null;
  closer_last_name: string | null;
  reopen_reason: string | null;
  reopened_at: Date | null;
  reopener_first_name: string | null;
  reopener_last_name: string | null;
  assigned_technician_id: number | null;
  assignee_first_name: string | null;
  assignee_last_name: string | null;
  assignment_status: string | null;
  cycle: number | null;
  gas_type: 'LPG' | 'CNG' | null;
  kit: string | null;
  ecu: string | null;
  cylinder: string | null;
  installation_note: string | null;
}

function toDetail(row: JobRow): JobDetail {
  return {
    id: row.id,
    status: row.status,
    customerId: row.customer_id,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    vehicleId: row.vehicle_id,
    plateNumber: row.plate_number,
    vin: row.vin,
    make: row.make,
    model: row.model,
    year: row.year,
    branchId: row.branch_id,
    branchName: row.branch_name,
    createdById: row.created_by,
    createdByName: `${row.creator_first_name} ${row.creator_last_name}`,
    createdAt: row.created_at,
    startedAt: row.started_at,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    cancelledByName: row.canceller_first_name ? `${row.canceller_first_name} ${row.canceller_last_name}` : null,
    closedAt: row.closed_at,
    closedByName: row.closer_first_name ? `${row.closer_first_name} ${row.closer_last_name}` : null,
    reopenReason: row.reopen_reason,
    reopenedAt: row.reopened_at,
    reopenedByName: row.reopener_first_name ? `${row.reopener_first_name} ${row.reopener_last_name}` : null,
    assignedTechnicianId: row.assigned_technician_id ?? null,
    assignedTechnicianName: row.assignee_first_name ? `${row.assignee_first_name} ${row.assignee_last_name}` : null,
    assignmentStatus: row.assignment_status ?? 'UNASSIGNED',
    cycle: row.cycle ?? 1,
    installation: {
      gasType: row.gas_type,
      kit: row.kit,
      ecu: row.ecu,
      cylinder: row.cylinder,
      note: row.installation_note,
    },
  };
}

const baseSelect = () =>
  db('jobs')
    .select(
      'jobs.*',
      'customers.name as customer_name',
      'customers.phone as customer_phone',
      'vehicles.plate_number',
      'vehicles.vin',
      'vehicles.make',
      'vehicles.model',
      'vehicles.year',
      'branches.name as branch_name',
      'creator.first_name as creator_first_name',
      'creator.last_name as creator_last_name',
      'canceller.first_name as canceller_first_name',
      'canceller.last_name as canceller_last_name',
      'closer.first_name as closer_first_name',
      'closer.last_name as closer_last_name',
      'reopener.first_name as reopener_first_name',
      'reopener.last_name as reopener_last_name',
      'assignee.first_name as assignee_first_name',
      'assignee.last_name as assignee_last_name',
    )
    .join('customers', 'customers.id', 'jobs.customer_id')
    .join('vehicles', 'vehicles.id', 'jobs.vehicle_id')
    .join('branches', 'branches.id', 'jobs.branch_id')
    .join('users as creator', 'creator.id', 'jobs.created_by')
    .leftJoin('users as canceller', 'canceller.id', 'jobs.cancelled_by')
    .leftJoin('users as closer', 'closer.id', 'jobs.closed_by')
    .leftJoin('users as reopener', 'reopener.id', 'jobs.reopened_by')
    .leftJoin('users as assignee', 'assignee.id', 'jobs.assigned_technician_id');

// ---------------------------------------------------------------------------
// Queries (branch-scoped per loyiha.md §11 via jobsBranchScope)
// ---------------------------------------------------------------------------

export interface ListJobsResult {
  jobs: JobDetail[];
  total: number;
  page: number;
  limit: number;
}

export async function listJobs(actor: AuthUser, query: ListJobsQuery): Promise<ListJobsResult> {
  const scope = jobsBranchScope(actor);

  const build = () => {
    const q = baseSelect();
    if (scope !== null) {
      // Branch-confined actors always see only their branch; a client-sent
      // branchId filter can never widen the scope.
      q.where('jobs.branch_id', scope);
    } else if (query.branchId) {
      q.where('jobs.branch_id', query.branchId);
    }
    if (query.status) q.where('jobs.status', query.status);
    if (query.search) {
      const term = `%${query.search.replace(/[%_]/g, '\\$&')}%`;
      const idTerm = `%${query.search.toUpperCase().replace(/[\s-]/g, '').replace(/[%_]/g, '\\$&')}%`;
      const phoneDigits = query.search.replace(/\D/g, '');
      const numericId = /^#?\d+$/.test(query.search.trim()) ? Number(query.search.trim().replace('#', '')) : null;
      q.where((sub) => {
        sub
          .where('vehicles.plate_number', 'like', idTerm)
          .orWhere('vehicles.vin', 'like', idTerm)
          .orWhere('customers.name', 'like', term);
        if (phoneDigits.length >= 4) sub.orWhere('customers.phone', 'like', `%${phoneDigits}%`);
        if (numericId !== null) sub.orWhere('jobs.id', numericId);
      });
    }
    return q;
  };

  const countRows = (await build()
    .clearSelect()
    .count({ count: '*' })) as unknown as [{ count: number | string }];
  const total = Number(countRows[0]?.count ?? 0);

  const rows = (await build()
    .orderBy('jobs.created_at', 'desc')
    .orderBy('jobs.id', 'desc')
    .limit(query.limit)
    .offset((query.page - 1) * query.limit)) as JobRow[];

  return { jobs: rows.map(toDetail), total, page: query.page, limit: query.limit };
}

export async function getJob(actor: AuthUser, id: number): Promise<JobDetail> {
  const scope = jobsBranchScope(actor);
  const row = (await baseSelect().where('jobs.id', id).first()) as JobRow | undefined;
  // Out-of-scope jobs 404 (not 403) so job ids cannot be probed across branches.
  if (!row || (scope !== null && row.branch_id !== scope)) {
    throw ApiError.notFound('Ish topilmadi');
  }
  return toDetail(row);
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export async function createJob(actor: AuthUser, input: CreateJobInput, meta: RequestMeta): Promise<JobDetail> {
  // The job's branch is ALWAYS the authenticated user's branch — a client-sent
  // branch id is never accepted (createJobSchema strips unknown fields).
  if (!actor.branchId) {
    throw ApiError.forbidden('Sizga filial biriktirilmagan', 'NO_BRANCH');
  }

  const id = await db.transaction(async (trx) => {
    const customer = await trx('customers').where({ id: input.customerId }).whereNull('deleted_at').first();
    if (!customer) throw ApiError.badRequest('Tanlangan mijoz mavjud emas', 'INVALID_CUSTOMER');

    const vehicle = await trx('vehicles').where({ id: input.vehicleId }).whereNull('deleted_at').first();
    if (!vehicle) throw ApiError.badRequest('Tanlangan avtomobil mavjud emas', 'INVALID_VEHICLE');

    // The client-supplied pair is never trusted independently: the vehicle
    // must actually belong to the selected customer.
    if (vehicle.customer_id !== input.customerId) {
      throw ApiError.badRequest('Avtomobil tanlangan mijozga tegishli emas', 'VEHICLE_CUSTOMER_MISMATCH');
    }

    const [newId] = await trx('jobs').insert({
      customer_id: input.customerId,
      vehicle_id: input.vehicleId,
      branch_id: actor.branchId,
      created_by: actor.id,
      status: 'DRAFT',
    });

    // Phase 10D: a USTA/MASTER opening a job is its responsible technician
    // (SELF_AT_CREATION) — recorded as immutable assignment history. An
    // admin-created job stays UNASSIGNED until a supervisor assigns one.
    await assignAtCreation(trx, newId as number, actor, 1);

    await logAudit(
      {
        userId: actor.id,
        action: 'JOB_CREATED',
        entityType: 'job',
        entityId: newId,
        newValue: {
          customerId: input.customerId,
          vehicleId: input.vehicleId,
          branchId: actor.branchId,
          status: 'DRAFT',
          assignedTechnicianId: ['USTA', 'MASTER'].includes(actor.role) ? actor.id : null,
        },
        ...meta,
      },
      trx,
    );

    return newId as number;
  });

  return getJob(actor, id);
}

// ---------------------------------------------------------------------------
// Explicit status transitions (no generic status PATCH exists)
// ---------------------------------------------------------------------------

/**
 * Loads and row-locks a job inside a transaction, enforcing branch scope
 * (404 out of scope) and the allowed source statuses (409 otherwise).
 */
async function lockJobForTransition(
  trx: Knex.Transaction,
  actor: AuthUser,
  id: number,
  allowedFrom: JobStatus[],
): Promise<{ id: number; status: JobStatus; branch_id: number }> {
  const scope = jobsBranchScope(actor);
  const job = (await trx('jobs').where({ id }).forUpdate().first()) as
    | { id: number; status: JobStatus; branch_id: number }
    | undefined;

  if (!job || (scope !== null && job.branch_id !== scope)) {
    throw ApiError.notFound('Ish topilmadi');
  }
  if (!allowedFrom.includes(job.status)) {
    throw ApiError.conflict(`Bu holatdagi ishni o'zgartirib bo'lmaydi (${job.status})`, 'INVALID_TRANSITION');
  }
  return job;
}

/** DRAFT → IN_PROGRESS (work begins). */
export async function startJob(actor: AuthUser, id: number, meta: RequestMeta): Promise<JobDetail> {
  await db.transaction(async (trx) => {
    await lockJobForTransition(trx, actor, id, ['DRAFT']);
    // Phase 10D governance: work may not start under an unapproved risk policy
    // (fail closed → RISK_POLICY_NOT_APPROVED).
    await assertRiskPolicyApproved(trx);
    await trx('jobs').where({ id }).update({ status: 'IN_PROGRESS', started_at: trx.fn.now(), updated_at: trx.fn.now() });
    await logAudit(
      {
        userId: actor.id,
        action: 'JOB_STARTED',
        entityType: 'job',
        entityId: id,
        oldValue: { status: 'DRAFT' },
        newValue: { status: 'IN_PROGRESS' },
        ...meta,
      },
      trx,
    );
  });
  return getJob(actor, id);
}

/**
 * Sets/updates the §13 installation details (gas type, kit, ECU, cylinder,
 * note). Allowed while the job is DRAFT or IN_PROGRESS — the installation is
 * described during the opening/working stage, never after closure.
 */
export async function updateInstallation(
  actor: AuthUser,
  id: number,
  input: InstallationInput,
  meta: RequestMeta,
): Promise<JobDetail> {
  await db.transaction(async (trx) => {
    const job = await lockJobForTransition(trx, actor, id, ['DRAFT', 'IN_PROGRESS']);

    const current = (await trx('jobs')
      .select('gas_type', 'kit', 'ecu', 'cylinder', 'installation_note')
      .where({ id: job.id })
      .first()) as Record<string, string | null>;

    const fieldMap = {
      gasType: 'gas_type',
      kit: 'kit',
      ecu: 'ecu',
      cylinder: 'cylinder',
      note: 'installation_note',
    } as const;

    const update: Record<string, unknown> = { updated_at: trx.fn.now() };
    const changes: Record<string, { old: unknown; new: unknown }> = {};
    for (const [inputKey, column] of Object.entries(fieldMap) as [keyof typeof fieldMap, string][]) {
      const next = input[inputKey];
      if (next !== undefined && next !== current[column]) {
        update[column] = next;
        changes[inputKey] = { old: current[column], new: next };
      }
    }

    if (Object.keys(changes).length > 0) {
      await trx('jobs').where({ id: job.id }).update(update);
      await logAudit(
        {
          userId: actor.id,
          action: 'JOB_INSTALLATION_UPDATED',
          entityType: 'job',
          entityId: job.id,
          newValue: changes,
          ...meta,
        },
        trx,
      );
    }
  });

  return getJob(actor, id);
}

/** DRAFT | IN_PROGRESS → CANCELLED, mandatory reason. */
export async function cancelJob(actor: AuthUser, id: number, reason: string, meta: RequestMeta): Promise<JobDetail> {
  await db.transaction(async (trx) => {
    const job = await lockJobForTransition(trx, actor, id, ['DRAFT', 'IN_PROGRESS']);
    await trx('jobs').where({ id }).update({
      status: 'CANCELLED',
      cancel_reason: reason,
      cancelled_by: actor.id,
      cancelled_at: trx.fn.now(),
      updated_at: trx.fn.now(),
    });
    await logAudit(
      {
        userId: actor.id,
        action: 'JOB_CANCELLED',
        entityType: 'job',
        entityId: id,
        oldValue: { status: job.status },
        newValue: { status: 'CANCELLED', reason },
        ...meta,
      },
      trx,
    );
  });
  return getJob(actor, id);
}
