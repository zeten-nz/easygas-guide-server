import { db } from '../../config/database';
import { ApiError } from '../../utils/errors';
import { jobsBranchScope } from '../../rbac/permissions';
import { getJob, type JobDetail } from '../jobs/jobs.service';
import { getJobChecklist, type JobChecklistView } from '../checklist/execution.service';
import { getJobStopApprovals, type StopApprovalRecord } from '../checklist/stop.service';
import { getSignature, validateJobCompletion, type CompletionReadiness, type SignatureDetail } from '../jobs/completion.service';
import type { AuthUser } from '../../types/auth';

export interface AuditTimelineEntry {
  action: string;
  actorName: string | null;
  oldValue: unknown;
  newValue: unknown;
  createdAt: Date;
}

export interface QualityView {
  job: JobDetail;
  checklist: JobChecklistView | null;
  stopApprovals: StopApprovalRecord[];
  signature: SignatureDetail | null;
  readiness: CompletionReadiness;
  timeline: AuditTimelineEntry[];
}

/**
 * §26 read-only inspection aggregate for the quality authority: the complete
 * operational history of a job in one response — identity, checklist with
 * measured values and evidence, every STOP attempt, the signature, completion
 * readiness and the audit timeline. Strictly read-only: this module performs
 * no mutations; only the explicit reopen/confirm operations change state.
 */
export async function getQualityView(actor: AuthUser, jobId: number): Promise<QualityView> {
  const scope = jobsBranchScope(actor);
  const jobRow = await db('jobs').where({ id: jobId }).first();
  if (!jobRow || (scope !== null && jobRow.branch_id !== scope)) {
    throw ApiError.notFound('Ish topilmadi');
  }

  const [job, checklist, stopApprovals, signature, readiness] = await Promise.all([
    getJob(actor, jobId),
    getJobChecklist(actor, jobId),
    getJobStopApprovals(actor, jobId),
    getSignature(actor, jobId),
    validateJobCompletion(jobId),
  ]);

  // Audit timeline: job-entity rows plus this job's step and STOP entities.
  const checklistIds = (await db('job_checklists').where({ job_id: jobId }).select('id')).map((c: { id: number }) => c.id);
  const stepIds =
    checklistIds.length > 0
      ? (await db('job_steps').whereIn('job_checklist_id', checklistIds).select('id')).map((s: { id: number }) => String(s.id))
      : [];
  const approvalIds = (await db('stop_approvals').where({ job_id: jobId }).select('id')).map((a: { id: number }) =>
    String(a.id),
  );

  const timelineRows = await db('audit_logs')
    .select('audit_logs.*', 'users.first_name', 'users.last_name')
    .leftJoin('users', 'users.id', 'audit_logs.user_id')
    .where((q) => {
      q.where((jq) => jq.where('entity_type', 'job').where('entity_id', String(jobId)));
      if (stepIds.length > 0) q.orWhere((sq) => sq.where('entity_type', 'job_step').whereIn('entity_id', stepIds));
      if (approvalIds.length > 0)
        q.orWhere((aq) => aq.where('entity_type', 'stop_approval').whereIn('entity_id', approvalIds));
    })
    .orderBy('audit_logs.id', 'desc')
    .limit(100);

  const parse = (v: unknown) => {
    if (v == null) return null;
    if (typeof v === 'string') {
      try {
        return JSON.parse(v);
      } catch {
        return v;
      }
    }
    return v;
  };

  return {
    job,
    checklist,
    stopApprovals,
    signature,
    readiness,
    timeline: timelineRows.map((r: Record<string, any>) => ({
      action: r.action,
      actorName: r.first_name ? `${r.first_name} ${r.last_name}` : null,
      oldValue: parse(r.old_value),
      newValue: parse(r.new_value),
      createdAt: r.created_at,
    })),
  };
}
