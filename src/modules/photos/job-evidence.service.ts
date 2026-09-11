import { db } from '../../config/database';
import { ApiError } from '../../utils/errors';
import { jobsBranchScope } from '../../rbac/permissions';
import { isWorkable } from '../jobs/job-cycle';
import type { AuthUser } from '../../types/auth';

/**
 * Phase 11C — read-only JOB-LEVEL photo-evidence listing for completed-job review.
 *
 * The pre-existing photo endpoints are STEP-scoped and READY-only. Reviewing a
 * completed job needs one truthful, cross-step, cross-cycle view. Honesty rules
 * this service enforces (see docs/PHASE-11C.md):
 *
 *  - `job_photos` has NO cycle column and NO capture time. A photo's cycle is
 *    derived ONLY from the immutable `completion_snapshots` (which froze the exact
 *    evidence photoIds per completed cycle) — never inferred from today's
 *    `jobs.cycle`, `jobs.assigned_technician_id`, or `jobs.status`.
 *  - Only `status='READY'` is real evidence and only READY rows are downloadable
 *    (via the existing step-scoped file endpoint, which re-checks READY). PENDING /
 *    UNVERIFIED (legacy) / FAILED rows are surfaced with their state, never as
 *    accessible evidence.
 *  - The uploader (`created_by`) is the performer of THAT upload — distinct from
 *    the job's current responsible technician.
 */

async function loadScopedJob(actor: AuthUser, jobId: number) {
  const scope = jobsBranchScope(actor);
  const job = await db('jobs').where({ id: jobId }).first();
  if (!job || (scope !== null && job.branch_id !== scope)) throw ApiError.notFound('Ish topilmadi');
  return job;
}

/**
 * Photo → the completed cycle(s) it was frozen as evidence for, from the immutable
 * snapshots (authoritative history). A photo CAN belong to more than one snapshot:
 * `completion_snapshots.content.summary.steps[].evidence[].photoId` is the READY
 * photos of each step's RELEVANT attempt at that cycle's close, so a step that is
 * NOT re-done across a reopen carries the SAME photoId into every subsequent cycle's
 * snapshot. We therefore record ALL cycles per photo (ascending), never overwrite.
 */
async function snapshotEvidence(jobId: number): Promise<{
  photoCycles: Map<number, number[]>;
  cycles: Array<{ cycle: number; provenance: string; createdAt: Date }>;
}> {
  const rows = await db('completion_snapshots').where({ job_id: jobId }).orderBy('cycle', 'asc').select('cycle', 'provenance', 'content', 'created_at');
  const photoCycles = new Map<number, number[]>();
  const cycles: Array<{ cycle: number; provenance: string; createdAt: Date }> = [];
  for (const r of rows) {
    cycles.push({ cycle: r.cycle, provenance: r.provenance, createdAt: r.created_at });
    let content: any;
    try {
      content = JSON.parse(r.content);
    } catch {
      continue; // malformed snapshot content — skip; the photo simply has no derived cycle
    }
    const steps = content?.summary?.steps;
    if (!Array.isArray(steps)) continue;
    for (const s of steps) {
      if (!Array.isArray(s?.evidence)) continue;
      for (const e of s.evidence) {
        if (typeof e?.photoId !== 'number') continue;
        const list = photoCycles.get(e.photoId) ?? [];
        if (!list.includes(r.cycle)) list.push(r.cycle); // ascending; dedupe
        photoCycles.set(e.photoId, list);
      }
    }
  }
  return { photoCycles, cycles };
}

/**
 * Truthful provenance role (server-computed; the client never infers it):
 *  - COMPLETED_CYCLE        — READY and frozen into ≥1 completed cycle's snapshot.
 *  - CURRENT                — READY, the step's CURRENT attempt (job_steps.attempt),
 *                             on a workable (in-progress/reopened) job, not yet
 *                             snapshotted → reliable current-attempt evidence.
 *  - SUPERSEDED_ATTEMPT     — READY but a strictly EARLIER attempt than the step's
 *                             current one (redone), and not carried into a snapshot.
 *  - HISTORICAL_UNCLASSIFIED— READY but provenance is insufficient to place it (a
 *                             terminal/cancelled job or a legacy completed job with
 *                             no snapshot). An honest "unclassified", NOT "current".
 *  - PENDING / UNVERIFIED / FAILED — not (yet / ever) valid evidence.
 */
export type EvidenceRole = 'COMPLETED_CYCLE' | 'CURRENT' | 'SUPERSEDED_ATTEMPT' | 'HISTORICAL_UNCLASSIFIED' | 'PENDING' | 'FAILED' | 'UNVERIFIED';

export interface JobPhotoItem {
  id: number;
  jobStepId: number;
  stepId: number;
  stepName: string;
  stepOrder: number;
  isStop: boolean;
  requiredPhotos: number;
  attempt: number;
  status: string; // READY | PENDING | UNVERIFIED | FAILED
  failureReason: string | null;
  /**
   * The UPLOADER of THIS photo (job_photos.created_by) — an immutable per-photo
   * fact. This is deliberately NOT the same stored fact as the step PERFORMER
   * (job_steps.completed_by) or the assigned technician: the step performer is a
   * current-state value that cannot be reliably attributed to a historical photo's
   * attempt/cycle (snapshots do not freeze the performer per attempt), so we never
   * guess it here. The client labels this as "Yuklagan" (uploaded by), not "performer".
   */
  uploadedById: number;
  uploadedByName: string;
  createdAt: Date;
  readyAt: Date | null;
  sizeBytes: number;
  mimeType: string;
  /** The LATEST completed cycle this photo was frozen as evidence for, or null. Never inferred. */
  cycle: number | null;
  /** ALL completed cycles this photo is snapshot evidence for (a photo can span cycles). */
  cycles: number[];
  /** Referenced by ≥1 completion snapshot (authoritative historical evidence). */
  snapshotEvidence: boolean;
  /** Truthful role for labelling — server-computed so the client never infers it. */
  role: EvidenceRole;
  /** Only READY is downloadable, via the existing step file endpoint. */
  downloadable: boolean;
}

export interface JobPhotosResult {
  job: {
    id: number;
    status: string;
    cycle: number;
    assignedTechnicianId: number | null;
    assignmentStatus: string | null;
  };
  cycles: Array<{ cycle: number; provenance: string; createdAt: Date }>;
  photos: JobPhotoItem[];
  total: number;
  page: number;
  limit: number;
}

export interface ListJobPhotosQuery {
  page: number;
  limit: number;
  cycle?: number;
  jobStepId?: number;
}

/**
 * Lists every photo evidence row for a job (all statuses/attempts) with truthful
 * per-photo provenance, bounded pagination and a deterministic order. The download
 * link is the EXISTING READY-only step endpoint — this listing adds no bypass.
 */
export async function listJobPhotos(actor: AuthUser, jobId: number, query: ListJobPhotosQuery): Promise<JobPhotosResult> {
  const job = await loadScopedJob(actor, jobId);
  const { photoCycles, cycles } = await snapshotEvidence(jobId);
  const workable = isWorkable(job);

  // If a cycle filter is set, confine to exactly the photoIds that cycle's snapshot
  // froze — an honest, complete group for a completed cycle (no partial groups). A
  // photo shared across cycles is included whenever the requested cycle is one of them.
  let cycleFilterIds: number[] | null = null;
  if (query.cycle != null) {
    cycleFilterIds = [...photoCycles.entries()].filter(([, cs]) => cs.includes(query.cycle!)).map(([id]) => id);
    if (cycleFilterIds.length === 0) {
      return { job: jobHeader(job), cycles, photos: [], total: 0, page: query.page, limit: query.limit };
    }
  }

  const base = db('job_photos as p')
    .join('job_steps as js', 'js.id', 'p.job_step_id')
    .join('checklist_steps as cs', 'cs.id', 'js.step_id')
    .join('users as u', 'u.id', 'p.created_by')
    .where('p.job_id', jobId);
  if (query.jobStepId != null) base.where('p.job_step_id', query.jobStepId);
  if (cycleFilterIds != null) base.whereIn('p.id', cycleFilterIds);

  const [{ c: total }] = (await base.clone().count({ c: 'p.id' })) as [{ c: number | string }];
  const rows = await base
    .clone()
    // Deterministic: newest completed cycle first is a client concern; here we order
    // by step then attempt then id so groups are contiguous and stable across pages.
    .orderBy('cs.sort_order', 'asc')
    .orderBy('p.attempt', 'asc')
    .orderBy('p.id', 'asc')
    .limit(query.limit)
    .offset((query.page - 1) * query.limit)
    .select(
      'p.id', 'p.job_step_id', 'p.attempt', 'p.status', 'p.failure_reason', 'p.created_by', 'p.created_at', 'p.ready_at', 'p.size_bytes', 'p.mime_type',
      'js.step_id', 'js.attempt as step_current_attempt', 'cs.name as step_name', 'cs.sort_order', 'cs.is_stop', 'cs.required_photos',
      'u.first_name', 'u.last_name',
    );

  const photos: JobPhotoItem[] = rows.map((r: any) => {
    const cyclesFor = photoCycles.get(r.id) ?? []; // ascending; may span multiple cycles
    const cycle = cyclesFor.length > 0 ? cyclesFor[cyclesFor.length - 1] : null; // latest
    // The step's OWN current attempt (job_steps.attempt) is the live truth for
    // current-vs-superseded; a completed cycle's evidence is identified by snapshot
    // membership instead — never by "absent from a snapshot".
    const isCurrentAttempt = r.attempt === r.step_current_attempt;
    let role: EvidenceRole;
    if (r.status !== 'READY') {
      role = r.status as EvidenceRole; // PENDING | UNVERIFIED | FAILED — not valid evidence
    } else if (cyclesFor.length > 0) {
      role = 'COMPLETED_CYCLE'; // frozen into ≥1 completed cycle's snapshot
    } else if (isCurrentAttempt && workable) {
      role = 'CURRENT'; // reliable current-attempt evidence of the in-progress/reopened cycle
    } else if (r.attempt < r.step_current_attempt) {
      role = 'SUPERSEDED_ATTEMPT'; // a strictly earlier attempt, not carried into a snapshot
    } else {
      // READY, but not snapshotted, not the current attempt of a workable job, and
      // not a clearly-earlier attempt (e.g. a cancelled/terminal job's evidence, or a
      // legacy completed job with no snapshot) — honest "unclassified", never "current".
      role = 'HISTORICAL_UNCLASSIFIED';
    }
    return {
      id: r.id,
      jobStepId: r.job_step_id,
      stepId: r.step_id,
      stepName: r.step_name,
      stepOrder: r.sort_order,
      isStop: !!r.is_stop,
      requiredPhotos: r.required_photos,
      attempt: r.attempt,
      status: r.status,
      failureReason: r.failure_reason ?? null,
      uploadedById: r.created_by,
      uploadedByName: `${r.first_name} ${r.last_name}`,
      createdAt: r.created_at,
      readyAt: r.ready_at ?? null,
      sizeBytes: r.size_bytes,
      mimeType: r.mime_type,
      cycle,
      cycles: cyclesFor,
      snapshotEvidence: cyclesFor.length > 0,
      role,
      downloadable: r.status === 'READY',
    };
  });

  return { job: jobHeader(job), cycles, photos, total: Number(total), page: query.page, limit: query.limit };
}

function jobHeader(job: Record<string, any>): JobPhotosResult['job'] {
  return {
    id: job.id,
    status: job.status,
    cycle: job.cycle ?? 1,
    assignedTechnicianId: job.assigned_technician_id ?? null,
    assignmentStatus: job.assignment_status ?? null,
  };
}
