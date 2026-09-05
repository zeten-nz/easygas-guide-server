import type { Knex } from 'knex';
import { db } from '../../config/database';
import { digestOf } from './canonical';

/**
 * Phase 10D signable completion summary + immutable completion snapshot.
 *
 * Both are built ONLY from authoritative server rows (never client-provided) and
 * serialized canonically (sorted keys, explicit array order, no volatile
 * timestamps inside the hashed content) so a recompute is deterministic.
 *
 * Digest composition (defined to avoid circular hashing):
 *  - SIGNABLE SUMMARY digest covers the MATERIAL work: installation, checklist
 *    steps (relevant attempt + evidence sha256), STOP state, open blocking risk
 *    ids, customer/vehicle/branch identity, assigned technician, cycle, checklist
 *    version. It does NOT include the signature (the customer signs THIS).
 *  - COMPLETION SNAPSHOT content embeds the summary (and its digest) PLUS the
 *    accepted signature reference (id + image sha256 + summary_digest) and
 *    completion actors. The snapshot digest is taken over that content.
 */

export const SUMMARY_SCHEMA_VERSION = 'summary-v1';
export const SNAPSHOT_SCHEMA_VERSION = 'snapshot-v1';

function maskPhone(p: string | null): string | null {
  if (!p) return null;
  const digits = p.replace(/\D/g, '');
  return digits.length >= 4 ? `***${digits.slice(-4)}` : '***';
}

/** Per-step relevant attempt = the one covered by the latest STOP decision, or 1. */
async function relevantAttempts(conn: Knex | Knex.Transaction, stepIds: number[]): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  if (stepIds.length === 0) return map;
  const rows = await conn('stop_approvals').whereIn('job_step_id', stepIds).orderBy('attempt', 'desc');
  for (const a of rows) if (!map.has(a.job_step_id)) map.set(a.job_step_id, a.attempt);
  return map;
}

interface Material {
  job: any;
  summary: Record<string, unknown>;
  cycle: number;
}

/** Collects the material work state for a job into a canonical-ready object. */
async function collectMaterial(conn: Knex | Knex.Transaction, jobId: number): Promise<Material | null> {
  const job = await conn('jobs').where({ id: jobId }).first();
  if (!job) return null;
  const cycle = job.cycle ?? 1;
  const customer = await conn('customers').where({ id: job.customer_id }).first();
  const vehicle = await conn('vehicles').where({ id: job.vehicle_id }).first();
  const checklist = await conn('job_checklists').where({ job_id: jobId }).first();
  const version = checklist ? await conn('checklist_template_versions').where({ id: checklist.version_id }).first() : null;

  const steps = checklist
    ? await conn('job_steps')
        .join('checklist_steps', 'checklist_steps.id', 'job_steps.step_id')
        .where('job_steps.job_checklist_id', checklist.id)
        .orderBy('checklist_steps.sort_order')
        .select('job_steps.id', 'job_steps.step_id', 'job_steps.status', 'job_steps.attempt', 'checklist_steps.sort_order', 'checklist_steps.name', 'checklist_steps.is_stop', 'checklist_steps.required_photos')
    : [];
  const stepIds = steps.map((s: any) => s.id);
  const relevant = await relevantAttempts(conn, stepIds);

  const stepSummaries = [];
  for (const s of steps) {
    const attempt = relevant.get(s.id) ?? 1;
    const photos = await conn('job_photos')
      .where({ job_step_id: s.id, attempt, status: 'READY' })
      .orderBy('id')
      .select('id', 'hash', 'size_bytes');
    const measurements = await conn('step_measurements')
      .where({ job_step_id: s.id, attempt })
      .orderBy('measurement_id')
      .select('measurement_id', 'value', 'is_within_range');
    stepSummaries.push({
      stepId: s.step_id,
      jobStepId: s.id,
      order: s.sort_order,
      name: s.name,
      isStop: !!s.is_stop,
      status: s.status,
      attempt,
      requiredPhotos: s.required_photos,
      evidence: photos.map((p: any) => ({ photoId: p.id, sha256: p.hash, size: p.size_bytes })),
      measurements: measurements.map((m: any) => ({ measurementId: m.measurement_id, value: String(m.value), withinRange: !!m.is_within_range })),
    });
  }

  const stops = stepIds.length
    ? await conn('stop_approvals').whereIn('job_step_id', stepIds).orderBy(['job_step_id', 'attempt']).select('job_step_id', 'attempt', 'status')
    : [];
  const openBlockingRisks = await conn('risk_events')
    .where({ job_id: jobId, cycle, blocking: true })
    .whereIn('status', ['OPEN', 'MITIGATION_IN_PROGRESS'])
    .orderBy('id')
    .pluck('id');

  const summary = {
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    jobId,
    cycle,
    branchId: job.branch_id,
    assignedTechnicianId: job.assigned_technician_id ?? null,
    checklistTemplateId: version?.template_id ?? null,
    checklistVersion: version?.version ?? null,
    installation: { gasType: job.gas_type ?? null, kit: job.kit ?? null, ecu: job.ecu ?? null, cylinder: job.cylinder ?? null, note: job.installation_note ?? null },
    customer: customer ? { id: customer.id, name: customer.name, phoneMasked: maskPhone(customer.phone) } : null,
    vehicle: vehicle ? { id: vehicle.id, plate: vehicle.plate_number, vin: vehicle.vin ?? null, make: vehicle.make ?? null, model: vehicle.model ?? null, year: vehicle.year ?? null } : null,
    steps: stepSummaries,
    stops: stops.map((s: any) => ({ jobStepId: s.job_step_id, attempt: s.attempt, status: s.status })),
    openBlockingRiskIds: openBlockingRisks,
  };
  return { job, summary, cycle };
}

export interface SignableSummary {
  schemaVersion: string;
  cycle: number;
  summary: Record<string, unknown>;
  digest: string;
}

/** Builds the current signable summary + its canonical digest (server-authoritative). */
export async function buildSignableSummary(jobId: number, conn: Knex | Knex.Transaction = db): Promise<SignableSummary | null> {
  const m = await collectMaterial(conn, jobId);
  if (!m) return null;
  return { schemaVersion: SUMMARY_SCHEMA_VERSION, cycle: m.cycle, summary: m.summary, digest: digestOf(m.summary) };
}

/** Recomputes only the authoritative summary digest (used to detect stale signatures). */
export async function currentSummaryDigest(jobId: number, conn: Knex | Knex.Transaction = db): Promise<string | null> {
  const s = await buildSignableSummary(jobId, conn);
  return s?.digest ?? null;
}

export interface SnapshotBuild {
  content: Record<string, unknown>;
  digest: string;
  summaryDigest: string;
  signatureHash: string | null;
}

/**
 * Builds the immutable completion-snapshot content for a cycle: the material
 * summary + the accepted signature reference + completion actors. Deterministic;
 * called inside the close transaction after actors/timestamps are set.
 */
export async function buildCompletionSnapshot(
  conn: Knex | Knex.Transaction,
  jobId: number,
  cycle: number,
  finalizedBy: number,
): Promise<SnapshotBuild> {
  const m = await collectMaterial(conn, jobId);
  if (!m) throw new Error('Cannot build snapshot: job not found');
  const summaryDigest = digestOf(m.summary);

  const signature = await conn('customer_signatures')
    .where({ job_id: jobId, cycle, status: 'READY' }).whereNull('superseded_at')
    .orderBy('id', 'desc')
    .first();

  const risks = await conn('risk_events')
    .where({ job_id: jobId, cycle })
    .orderBy('id')
    .select('id', 'level', 'blocking', 'status', 'source', 'matrix_version');

  const content = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    provenance: 'FINALIZED',
    job: { id: jobId, cycle, status: m.job.status, branchId: m.job.branch_id, closedBy: m.job.closed_by ?? null },
    assignment: { technicianId: m.job.assigned_technician_id ?? null, status: m.job.assignment_status ?? null },
    summary: m.summary,
    summaryDigest,
    signature: signature ? { id: signature.id, sha256: signature.hash, sizeBytes: signature.size_bytes, summaryDigest: signature.summary_digest ?? null } : null,
    risks: risks.map((r: any) => ({ id: r.id, level: r.level, blocking: !!r.blocking, status: r.status, source: r.source, matrixVersion: r.matrix_version })),
    finalizedBy,
  };
  return { content, digest: digestOf(content), summaryDigest, signatureHash: signature?.hash ?? null };
}

/** Reads a finalized snapshot for the completed API/history (stored, never re-joined). */
export async function getCompletionSnapshot(jobId: number, cycle?: number): Promise<{ cycle: number; digest: string; content: unknown; schemaVersion: string; provenance: string; createdAt: Date } | null> {
  const q = db('completion_snapshots').where({ job_id: jobId });
  const row = cycle != null ? await q.where({ cycle }).first() : await q.orderBy('cycle', 'desc').first();
  if (!row) return null;
  return { cycle: row.cycle, digest: row.digest, content: JSON.parse(row.content), schemaVersion: row.schema_version, provenance: row.provenance, createdAt: row.created_at };
}
