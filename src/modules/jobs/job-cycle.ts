/**
 * §24 reopen-cycle helpers, shared by checklist/STOP/photo/completion logic.
 *
 * A job is in an ACTIVE reopened correction cycle when it has been reopened
 * and not yet re-closed: reopened_at exists and is newer than the latest
 * closed_at. During that cycle REOPENED plays the role IN_PROGRESS plays in
 * the first cycle (checklist work, photos, STOP submissions happen there),
 * and STOP decisions/reworks return the job to REOPENED instead of IN_PROGRESS.
 */
export interface JobCycleFields {
  status: string;
  closed_at: Date | string | null;
  reopened_at: Date | string | null;
}

export function isReopenCycle(job: JobCycleFields): boolean {
  // The REOPENED status itself only exists inside an active cycle.
  if (job.status === 'REOPENED') return true;
  if (!job.reopened_at) return false;
  if (!job.closed_at) return true;
  // >= because MySQL TIMESTAMP has 1-second precision: a close and a reopen
  // landing in the same second still mean the reopen came last (a job can
  // only be reopened after it was closed).
  return new Date(job.reopened_at).getTime() >= new Date(job.closed_at).getTime();
}

/** The working status of the job's current cycle. */
export function workingStatus(job: JobCycleFields): 'IN_PROGRESS' | 'REOPENED' {
  return isReopenCycle(job) ? 'REOPENED' : 'IN_PROGRESS';
}

/** True when checklist work (steps, photos, evidence) may happen right now. */
export function isWorkable(job: JobCycleFields): boolean {
  return job.status === 'IN_PROGRESS' || job.status === 'REOPENED';
}
