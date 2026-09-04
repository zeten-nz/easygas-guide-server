import type { Knex } from 'knex';
import { db } from '../../config/database';
import { ApiError } from '../../utils/errors';
import { logAudit } from '../audit/audit.service';
import { can } from '../../rbac/permissions';
import { jobsBranchScope } from '../../rbac/permissions';
import { computeRisk, RISK_MATRIX_VERSION, type RiskSource } from './risk-matrix';
import type { AuthUser } from '../../types/auth';

/**
 * Phase 10D risk engine (loyiha.md §21). Server-authoritative: the client may
 * propose a hazard/severity/likelihood, but score/level/blocking are computed
 * here under a frozen matrix version. Every mutation locks the JOB row first
 * (lock order: job → cycle → step → STOP/risk), so risk creation/resolution and
 * job completion serialize — a blocking risk can never be created concurrently
 * with a close such that both succeed. Safety records are never deleted; a
 * correction supersedes (revision chain) and every change is audited.
 */

interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

const OPEN_STATUSES = ['OPEN', 'MITIGATION_IN_PROGRESS'] as const;

/**
 * A risk may be raised on any non-terminal job — including QUALITY_REVIEW (a
 * quality reviewer finding an issue must be able to raise a blocking risk that
 * then blocks quality confirmation). Terminal (COMPLETED) and CANCELLED jobs
 * cannot receive new risks, so a risk can never be created concurrently with a
 * successful completion.
 */
function isRiskRaisable(job: { status: string }): boolean {
  return job.status !== 'COMPLETED' && job.status !== 'CANCELLED';
}

async function loadScopedJob(actor: AuthUser, jobId: number, trx: Knex.Transaction, lock: boolean) {
  const scope = jobsBranchScope(actor);
  let q = trx('jobs').where({ id: jobId });
  if (lock) q = q.forUpdate();
  const job = await q.first();
  if (!job || (scope !== null && job.branch_id !== scope)) throw ApiError.notFound('Ish topilmadi');
  return job;
}

/** Counts unresolved BLOCKING risks for a job cycle — the §22 completion gate input. */
export async function countOpenBlockingRisks(conn: Knex | Knex.Transaction, jobId: number, cycle: number): Promise<number> {
  const [{ c }] = (await conn('risk_events')
    .where({ job_id: jobId, cycle, blocking: true })
    .whereIn('status', OPEN_STATUSES as unknown as string[])
    .count({ c: '*' })) as [{ c: number | string }];
  return Number(c);
}

export interface CreateRiskInput {
  hazard: string;
  description: string;
  severity: number;
  likelihood: number;
  jobStepId?: number | null;
  responsibleUserId?: number | null;
  source?: RiskSource;
}

export async function createRisk(actor: AuthUser, jobId: number, input: CreateRiskInput, meta: RequestMeta): Promise<{ id: number }> {
  if (!can(actor.role, 'risks.create')) throw ApiError.forbidden();
  if (!input.hazard?.trim() || !input.description?.trim()) {
    throw ApiError.badRequest('Xavf turi va tavsifi majburiy', 'RISK_INPUT_REQUIRED');
  }
  const source: RiskSource = input.source ?? 'MANUAL';
  const assessment = computeRisk({ severity: input.severity, likelihood: input.likelihood, source });

  return db.transaction(async (trx) => {
    const job = await loadScopedJob(actor, jobId, trx, true);
    if (!isRiskRaisable(job)) throw ApiError.conflict('Yopilgan ish uchun xavf qo\'shib bo\'lmaydi', 'JOB_NOT_WORKABLE');

    let attempt: number | null = null;
    if (input.jobStepId != null) {
      const step = await trx('job_steps')
        .join('job_checklists', 'job_checklists.id', 'job_steps.job_checklist_id')
        .where('job_steps.id', input.jobStepId)
        .where('job_checklists.job_id', jobId)
        .select('job_steps.attempt')
        .first();
      if (!step) throw ApiError.badRequest('Bosqich ushbu ishga tegishli emas', 'INVALID_STEP');
      attempt = step.attempt as number;
    }

    const [id] = await trx('risk_events').insert({
      job_id: jobId,
      cycle: job.cycle ?? 1,
      job_step_id: input.jobStepId ?? null,
      attempt,
      hazard: input.hazard.trim().slice(0, 80),
      description: input.description.trim(),
      severity: input.severity ?? null,
      likelihood: input.likelihood ?? null,
      score: assessment.score,
      level: assessment.level,
      blocking: assessment.blocking,
      matrix_version: assessment.matrixVersion,
      source,
      status: 'OPEN',
      created_by: actor.id,
      responsible_user_id: input.responsibleUserId ?? job.assigned_technician_id ?? null,
    });

    await logAudit(
      {
        userId: actor.id,
        action: 'RISK_CREATED',
        entityType: 'risk_event',
        entityId: id,
        newValue: { jobId, cycle: job.cycle ?? 1, level: assessment.level, blocking: assessment.blocking, source, matrixVersion: assessment.matrixVersion },
        ...meta,
      },
      trx,
    );
    return { id: id as number };
  });
}

/**
 * Auto-links a blocking risk to a REJECTED STOP (called INSIDE the STOP-reject
 * transaction — see stop.service). CRITICAL by policy (a safety checkpoint
 * failed). Deduplicated per (job, cycle, step) so a re-reject does not pile up
 * duplicate blocking records.
 */
export async function linkStopRejectionRisk(
  trx: Knex.Transaction,
  args: { jobId: number; cycle: number; jobStepId: number; attempt: number; actorId: number; stepName: string; reason: string },
  meta: RequestMeta,
): Promise<void> {
  const existing = await trx('risk_events')
    .where({ job_id: args.jobId, cycle: args.cycle, job_step_id: args.jobStepId, source: 'STOP_REJECTED' })
    .whereIn('status', OPEN_STATUSES as unknown as string[])
    .first();
  if (existing) return; // preserve independent history without duplicating the blocker

  const assessment = computeRisk({ severity: 4, likelihood: 4, source: 'STOP_REJECTED' });
  const [id] = await trx('risk_events').insert({
    job_id: args.jobId,
    cycle: args.cycle,
    job_step_id: args.jobStepId,
    attempt: args.attempt,
    hazard: 'STOP_CHECKPOINT_REJECTED',
    description: `STOP "${args.stepName}" rad etildi: ${args.reason}`.slice(0, 1000),
    severity: 4,
    likelihood: 4,
    score: assessment.score,
    level: assessment.level,
    blocking: assessment.blocking,
    matrix_version: assessment.matrixVersion,
    source: 'STOP_REJECTED',
    status: 'OPEN',
    created_by: args.actorId,
  });
  await logAudit(
    { userId: args.actorId, action: 'RISK_CREATED', entityType: 'risk_event', entityId: id, newValue: { jobId: args.jobId, cycle: args.cycle, source: 'STOP_REJECTED', level: assessment.level }, ...meta },
    trx,
  );
}

/**
 * Resolves the open STOP-linked risk when a STOP is APPROVED after correction
 * (called INSIDE the STOP-approve transaction). The approved STOP decision is
 * the mitigation evidence.
 */
export async function resolveStopRisk(
  trx: Knex.Transaction,
  args: { jobId: number; cycle: number; jobStepId: number; actorId: number; stopApprovalId: number },
  meta: RequestMeta,
): Promise<void> {
  const rows = await trx('risk_events')
    .where({ job_id: args.jobId, cycle: args.cycle, job_step_id: args.jobStepId, source: 'STOP_REJECTED' })
    .whereIn('status', OPEN_STATUSES as unknown as string[])
    .forUpdate();
  for (const r of rows) {
    await trx('risk_events').where({ id: r.id }).update({
      status: 'RESOLVED',
      resolved_by: args.actorId,
      resolved_at: trx.raw('CURRENT_TIMESTAMP(6)'),
      resolution_note: 'STOP tasdiqlandi (mitigatsiya qabul qilindi)',
      resolution_stop_approval_id: args.stopApprovalId,
      updated_at: trx.raw('CURRENT_TIMESTAMP(6)'),
    });
    await logAudit(
      { userId: args.actorId, action: 'RISK_RESOLVED', entityType: 'risk_event', entityId: r.id, newValue: { via: 'STOP_APPROVAL', stopApprovalId: args.stopApprovalId }, ...meta },
      trx,
    );
  }
}

export interface ResolveRiskInput {
  note: string;
  mitigation?: string;
}

export async function resolveRisk(actor: AuthUser, riskId: number, input: ResolveRiskInput, meta: RequestMeta): Promise<void> {
  if (!can(actor.role, 'risks.resolve')) throw ApiError.forbidden();
  if (!input.note?.trim()) throw ApiError.badRequest('Yechim izohi majburiy', 'RESOLUTION_NOTE_REQUIRED');

  await db.transaction(async (trx) => {
    const risk = await trx('risk_events').where({ id: riskId }).forUpdate().first();
    if (!risk) throw ApiError.notFound('Xavf topilmadi');
    await loadScopedJob(actor, risk.job_id, trx, true); // branch scope + job lock (serialize vs close)
    if (!OPEN_STATUSES.includes(risk.status)) throw ApiError.conflict('Xavf allaqachon yopilgan', 'RISK_NOT_OPEN');

    await trx('risk_events').where({ id: riskId }).update({
      status: 'RESOLVED',
      mitigation: input.mitigation ?? risk.mitigation,
      resolution_note: input.note.trim(),
      resolved_by: actor.id,
      resolved_at: trx.raw('CURRENT_TIMESTAMP(6)'),
      updated_at: trx.raw('CURRENT_TIMESTAMP(6)'),
    });
    await logAudit(
      { userId: actor.id, action: 'RISK_RESOLVED', entityType: 'risk_event', entityId: riskId, oldValue: { status: risk.status, level: risk.level }, newValue: { status: 'RESOLVED' }, ...meta },
      trx,
    );
  });
}

export interface ReviseRiskInput {
  severity: number;
  likelihood: number;
  hazard?: string;
  description?: string;
  reason: string;
}

/**
 * A correction creates a NEW superseding row (preserving the original) — a
 * severity/likelihood change can never be an unaudited bypass. Requires the
 * supervisory `risks.resolve` permission and a reason.
 */
export async function reviseRisk(actor: AuthUser, riskId: number, input: ReviseRiskInput, meta: RequestMeta): Promise<{ id: number }> {
  if (!can(actor.role, 'risks.resolve')) throw ApiError.forbidden();
  if (!input.reason?.trim()) throw ApiError.badRequest('Tuzatish sababi majburiy', 'REVISION_REASON_REQUIRED');

  return db.transaction(async (trx) => {
    const orig = await trx('risk_events').where({ id: riskId }).forUpdate().first();
    if (!orig) throw ApiError.notFound('Xavf topilmadi');
    const job = await loadScopedJob(actor, orig.job_id, trx, true);
    if (!OPEN_STATUSES.includes(orig.status)) throw ApiError.conflict('Yopilgan xavfni tuzatib bo\'lmaydi', 'RISK_NOT_OPEN');

    const assessment = computeRisk({ severity: input.severity, likelihood: input.likelihood, source: orig.source });
    const [newId] = await trx('risk_events').insert({
      job_id: orig.job_id,
      cycle: orig.cycle,
      job_step_id: orig.job_step_id,
      attempt: orig.attempt,
      hazard: (input.hazard ?? orig.hazard).slice(0, 80),
      description: input.description ?? orig.description,
      severity: input.severity,
      likelihood: input.likelihood,
      score: assessment.score,
      level: assessment.level,
      blocking: assessment.blocking,
      matrix_version: assessment.matrixVersion,
      source: orig.source,
      status: 'OPEN',
      created_by: actor.id,
      responsible_user_id: orig.responsible_user_id,
      supersedes_id: orig.id,
    });
    // Original is superseded (preserved, not deleted).
    await trx('risk_events').where({ id: orig.id }).update({ status: 'REJECTED', updated_at: trx.raw('CURRENT_TIMESTAMP(6)') });
    await logAudit(
      { userId: actor.id, action: 'RISK_REVISED', entityType: 'risk_event', entityId: newId, oldValue: { id: orig.id, level: orig.level, blocking: orig.blocking }, newValue: { id: newId, level: assessment.level, blocking: assessment.blocking, reason: input.reason.trim() }, ...meta },
      trx,
    );
    void job;
    return { id: newId as number };
  });
}

export async function overrideRisk(actor: AuthUser, riskId: number, reason: string, meta: RequestMeta): Promise<void> {
  if (!can(actor.role, 'risks.override')) throw ApiError.forbidden();
  if (!reason?.trim()) throw ApiError.badRequest('Override sababi majburiy', 'OVERRIDE_REASON_REQUIRED');

  await db.transaction(async (trx) => {
    const risk = await trx('risk_events').where({ id: riskId }).forUpdate().first();
    if (!risk) throw ApiError.notFound('Xavf topilmadi');
    await loadScopedJob(actor, risk.job_id, trx, true);
    if (!OPEN_STATUSES.includes(risk.status)) throw ApiError.conflict('Xavf allaqachon yopilgan', 'RISK_NOT_OPEN');
    await trx('risk_events').where({ id: riskId }).update({
      status: 'RESOLVED',
      resolution_note: `OVERRIDE: ${reason.trim()}`,
      resolved_by: actor.id,
      resolved_at: trx.raw('CURRENT_TIMESTAMP(6)'),
      updated_at: trx.raw('CURRENT_TIMESTAMP(6)'),
    });
    await logAudit(
      { userId: actor.id, action: 'RISK_OVERRIDE', entityType: 'risk_event', entityId: riskId, oldValue: { level: risk.level, blocking: risk.blocking }, newValue: { status: 'RESOLVED', reason: reason.trim() }, ...meta },
      trx,
    );
  });
}

export interface RiskListItem {
  id: number;
  cycle: number;
  hazard: string;
  description: string;
  level: string;
  blocking: boolean;
  status: string;
  matrixVersion: string;
  source: string;
  jobStepId: number | null;
  createdAt: Date;
}

export async function listRisks(
  actor: AuthUser,
  jobId: number,
  opts: { cycle?: number; page?: number; pageSize?: number } = {},
): Promise<{ items: RiskListItem[]; page: number; pageSize: number; total: number }> {
  const scope = jobsBranchScope(actor);
  const job = await db('jobs').where({ id: jobId }).first();
  if (!job || (scope !== null && job.branch_id !== scope)) throw ApiError.notFound('Ish topilmadi');

  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 50));
  const base = db('risk_events').where({ job_id: jobId });
  if (opts.cycle != null) base.where({ cycle: opts.cycle });
  const [{ c }] = (await base.clone().count({ c: '*' })) as [{ c: number | string }];
  const rows = await base
    .clone()
    .orderBy('created_at', 'desc')
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .select('id', 'cycle', 'hazard', 'description', 'level', 'blocking', 'status', 'matrix_version', 'source', 'job_step_id', 'created_at');
  return {
    items: rows.map((r: Record<string, any>) => ({
      id: r.id,
      cycle: r.cycle,
      hazard: r.hazard,
      description: r.description,
      level: r.level,
      blocking: !!r.blocking,
      status: r.status,
      matrixVersion: r.matrix_version,
      source: r.source,
      jobStepId: r.job_step_id,
      createdAt: r.created_at,
    })),
    page,
    pageSize,
    total: Number(c),
  };
}

export { RISK_MATRIX_VERSION };
