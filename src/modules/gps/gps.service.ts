import { db } from '../../config/database';
import { env } from '../../config/env';
import { ApiError } from '../../utils/errors';
import { logAudit } from '../audit/audit.service';
import { can, jobsBranchScope } from '../../rbac/permissions';
import type { AuthUser } from '../../types/auth';

/**
 * Phase 10D GPS evidence (loyiha.md §20). GPS is client-REPORTED location
 * evidence, NOT proof of physical presence — the server validates ranges,
 * accuracy, and age (client + server timestamps both stored), labels its
 * provenance, and never silently accepts (0,0) or a coordinate the client may
 * have faked. It is captured at installation (job start) and is NOT a completion
 * gate; an authorized role may record an OVERRIDE with a reason when acceptable
 * GPS is unavailable. RBAC + branch scope apply; capture and rejection are
 * audited (coordinates are stored but not placed in audit metadata).
 */

interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export const GPS_PURPOSES = ['JOB_START', 'CHECKLIST_COMPLETE', 'CUSTOMER_SIGNATURE', 'JOB_COMPLETE', 'RISK_STOP_EVENT'] as const;
export type GpsPurpose = (typeof GPS_PURPOSES)[number];

export interface CaptureGpsInput {
  latitude: number;
  longitude: number;
  accuracy: number;
  clientTimestamp: string | number; // ISO string or epoch ms
  purpose?: GpsPurpose;
}

async function loadScopedJob(actor: AuthUser, jobId: number) {
  const scope = jobsBranchScope(actor);
  const job = await db('jobs').where({ id: jobId }).first();
  if (!job || (scope !== null && job.branch_id !== scope)) throw ApiError.notFound('Ish topilmadi');
  return job;
}

/** Pure validation → a sanitized rejection code, or null when acceptable. */
export function validateGps(input: CaptureGpsInput, nowMs = Date.now()): string | null {
  const { latitude: lat, longitude: lng, accuracy: acc } = input;
  if (![lat, lng, acc].every((n) => typeof n === 'number' && Number.isFinite(n))) return 'NAN_OR_INFINITE';
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return 'OUT_OF_RANGE';
  if (lat === 0 && lng === 0) return 'NULL_ISLAND'; // no silent 0,0 fallback
  if (acc <= 0 || acc > env.GPS_MAX_ACCURACY_METERS) return 'LOW_ACCURACY';
  const ts = typeof input.clientTimestamp === 'number' ? input.clientTimestamp : Date.parse(input.clientTimestamp);
  if (!Number.isFinite(ts)) return 'BAD_TIMESTAMP';
  if (ts > nowMs + env.GPS_FUTURE_SKEW_SECONDS * 1000) return 'FUTURE_TIMESTAMP';
  if (ts < nowMs - env.GPS_MAX_AGE_SECONDS * 1000) return 'STALE';
  return null;
}

export async function captureGps(actor: AuthUser, jobId: number, input: CaptureGpsInput, meta: RequestMeta): Promise<{ id: number }> {
  const job = await loadScopedJob(actor, jobId);
  const purpose: GpsPurpose = input.purpose ?? 'JOB_START';
  const reject = validateGps(input);
  if (reject) {
    // Audit the rejection WITHOUT storing exact coordinates in the audit payload.
    await logAudit({ userId: actor.id, action: 'GPS_REJECTED', entityType: 'job', entityId: jobId, newValue: { purpose, reason: reject, accuracy: input.accuracy }, ...meta });
    throw new ApiError(422, 'GPS_INVALID', 'GPS ma\'lumoti qabul qilinmadi', [{ code: reject, field: 'gps', message: reject }]);
  }
  const ts = typeof input.clientTimestamp === 'number' ? new Date(input.clientTimestamp) : new Date(Date.parse(input.clientTimestamp));
  const [id] = await db('job_gps_events').insert({
    job_id: jobId,
    cycle: job.cycle ?? 1,
    actor_id: actor.id,
    purpose,
    latitude: input.latitude,
    longitude: input.longitude,
    accuracy_m: input.accuracy,
    client_timestamp: ts,
    source: 'BROWSER_GEOLOCATION',
    provenance: 'VALIDATED',
  });
  await logAudit({ userId: actor.id, action: 'GPS_CAPTURED', entityType: 'job', entityId: jobId, newValue: { gpsId: id, purpose, provenance: 'VALIDATED', accuracy: input.accuracy }, ...meta });
  return { id: id as number };
}

export async function overrideGps(actor: AuthUser, jobId: number, purpose: GpsPurpose, reason: string, meta: RequestMeta): Promise<{ id: number }> {
  if (!can(actor.role, 'gps.override')) throw ApiError.forbidden();
  if (!reason?.trim()) throw ApiError.badRequest('Override sababi majburiy', 'GPS_OVERRIDE_REASON_REQUIRED');
  const job = await loadScopedJob(actor, jobId);
  const [id] = await db('job_gps_events').insert({
    job_id: jobId,
    cycle: job.cycle ?? 1,
    actor_id: actor.id,
    purpose,
    provenance: 'OVERRIDE',
    override_reason: reason.trim(),
    override_by: actor.id,
  });
  await logAudit({ userId: actor.id, action: 'GPS_OVERRIDE', entityType: 'job', entityId: jobId, newValue: { gpsId: id, purpose, reason: reason.trim() }, ...meta });
  return { id: id as number };
}

export async function listGps(actor: AuthUser, jobId: number, opts: { page?: number; pageSize?: number } = {}): Promise<{ items: any[]; page: number; pageSize: number; total: number }> {
  await loadScopedJob(actor, jobId);
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 50));
  const q = db('job_gps_events').where({ job_id: jobId });
  const [{ c }] = (await q.clone().count({ c: '*' })) as [{ c: number | string }];
  const rows = await q.clone().orderBy('created_at', 'desc').limit(pageSize).offset((page - 1) * pageSize)
    .select('id', 'cycle', 'purpose', 'latitude', 'longitude', 'accuracy_m', 'client_timestamp', 'server_received_at', 'provenance', 'actor_id');
  return { items: rows, page, pageSize, total: Number(c) };
}
