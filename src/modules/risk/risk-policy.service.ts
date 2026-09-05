import type { Knex } from 'knex';
import { db } from '../../config/database';
import { ApiError } from '../../utils/errors';
import { logAudit } from '../audit/audit.service';
import { can } from '../../rbac/permissions';
import type { AuthUser } from '../../types/auth';
import { RISK_LEVELS, type RiskLevel, type RiskSource } from './risk-matrix';

/**
 * Phase 10D risk-matrix GOVERNANCE. A matrix definition is immutable and moves
 * through DRAFT → ACTIVE → RETIRED with an explicit, audited approval
 * (approved_by/at/rationale). Only `risk.matrix.approve` (SIFAT/ADMIN) may
 * create/activate/retire. Exactly one ACTIVE matrix at a time. Safety operations
 * fail CLOSED (RISK_POLICY_NOT_APPROVED) when there is no ACTIVE matrix — the v1
 * thresholds are PROVISIONAL until EasyGas's safety specialist activates them.
 */

interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export interface MatrixDefinition {
  algorithm: 'severity_x_likelihood';
  allowedSeverity: number[];
  allowedLikelihood: number[];
  thresholds: { min: number; level: RiskLevel }[]; // descending; first match wins
  blockingLevels: RiskLevel[];
  sourceOverrides?: Partial<Record<RiskSource, RiskLevel>>;
  severity4MinLevel?: RiskLevel;
}

/** The PROVISIONAL v1 policy (seeded DRAFT; must be approved to govern). */
export const V1_DEFINITION: MatrixDefinition = {
  algorithm: 'severity_x_likelihood',
  allowedSeverity: [1, 2, 3, 4],
  allowedLikelihood: [1, 2, 3, 4],
  thresholds: [
    { min: 12, level: 'CRITICAL' },
    { min: 8, level: 'HIGH' },
    { min: 4, level: 'MEDIUM' },
    { min: 0, level: 'LOW' },
  ],
  blockingLevels: ['CRITICAL'],
  sourceOverrides: { STOP_REJECTED: 'CRITICAL' },
  severity4MinLevel: 'HIGH',
};

export interface RiskAssessment {
  matrixVersion: string;
  score: number;
  level: RiskLevel;
  blocking: boolean;
}

const LEVEL_ORDER: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

/** Deterministic classification for a definition (no DB access). */
export function classify(def: MatrixDefinition, severity: number, likelihood: number, source: RiskSource): { score: number; level: RiskLevel; blocking: boolean } {
  const s = Math.min(4, Math.max(1, Math.round(Number.isFinite(severity) ? severity : 1)));
  const l = Math.min(4, Math.max(1, Math.round(Number.isFinite(likelihood) ? likelihood : 1)));
  const score = s * l;
  let level: RiskLevel = 'LOW';
  for (const t of def.thresholds) {
    if (score >= t.min) { level = t.level; break; }
  }
  const override = def.sourceOverrides?.[source];
  if (override) level = override;
  else if (def.severity4MinLevel && s === 4 && LEVEL_ORDER[level] < LEVEL_ORDER[def.severity4MinLevel]) level = def.severity4MinLevel;
  return { score, level, blocking: def.blockingLevels.includes(level) };
}

/** Validation (requirement 17): returns problem strings (empty = valid). */
export function validateDefinition(def: unknown): string[] {
  const problems: string[] = [];
  const d = def as MatrixDefinition;
  if (!d || typeof d !== 'object') return ['definition must be an object'];
  if (d.algorithm !== 'severity_x_likelihood') problems.push('unsupported algorithm');
  if (!Array.isArray(d.allowedSeverity) || d.allowedSeverity.length === 0) problems.push('allowedSeverity required');
  if (!Array.isArray(d.allowedLikelihood) || d.allowedLikelihood.length === 0) problems.push('allowedLikelihood required');
  if (!Array.isArray(d.thresholds) || d.thresholds.length === 0) problems.push('thresholds required');
  else {
    if (!d.thresholds.some((t) => t.min <= 1)) problems.push('thresholds must cover the full score range (a min<=1 catch-all)');
    for (const t of d.thresholds) if (!RISK_LEVELS.includes(t.level)) problems.push(`invalid threshold level ${t.level}`);
    // descending order for deterministic first-match classification
    for (let i = 1; i < d.thresholds.length; i++) if (d.thresholds[i].min > d.thresholds[i - 1].min) problems.push('thresholds must be descending');
  }
  if (!Array.isArray(d.blockingLevels) || d.blockingLevels.length === 0) problems.push('at least one blocking level required');
  else if (!d.blockingLevels.includes('CRITICAL')) problems.push('blockingLevels must include CRITICAL (consistent with §22)');
  // complete coverage: every allowed severity×likelihood must classify to a level
  if (Array.isArray(d.allowedSeverity) && Array.isArray(d.allowedLikelihood) && Array.isArray(d.thresholds)) {
    for (const s of d.allowedSeverity) for (const l of d.allowedLikelihood) {
      const score = s * l;
      if (!d.thresholds.some((t) => score >= t.min)) problems.push(`score ${score} has no classification`);
    }
  }
  return problems;
}

export interface ActiveMatrix {
  version: string;
  definition: MatrixDefinition;
}

/** The current ACTIVE matrix, or null (fail-closed decisions read this). */
export async function getActiveMatrix(conn: Knex | Knex.Transaction = db): Promise<ActiveMatrix | null> {
  const row = await conn('risk_matrix_versions').where({ status: 'ACTIVE' }).first();
  if (!row) return null;
  return { version: row.version, definition: JSON.parse(row.definition) as MatrixDefinition };
}

export async function riskPolicyActive(conn: Knex | Knex.Transaction = db): Promise<boolean> {
  return (await getActiveMatrix(conn)) !== null;
}

/**
 * Assesses a risk under the ACTIVE matrix. Fails CLOSED with
 * RISK_POLICY_NOT_APPROVED when no matrix is active — no risk can be scored, so
 * no safety operation proceeds on an unapproved policy.
 */
export async function assessRisk(conn: Knex | Knex.Transaction, input: { severity: number; likelihood: number; source: RiskSource }): Promise<RiskAssessment> {
  const active = await getActiveMatrix(conn);
  if (!active) throw new ApiError(409, 'RISK_POLICY_NOT_APPROVED', "Xavf matritsasi tasdiqlanmagan — xavfsizlik siyosati faollashtirilishi kerak");
  const c = classify(active.definition, input.severity, input.likelihood, input.source);
  return { matrixVersion: active.version, score: c.score, level: c.level, blocking: c.blocking };
}

/** Guards a safety operation (job start / completion) on an ACTIVE matrix. */
export async function assertRiskPolicyApproved(conn: Knex | Knex.Transaction = db): Promise<void> {
  if (!(await riskPolicyActive(conn))) {
    throw new ApiError(409, 'RISK_POLICY_NOT_APPROVED', "Xavf matritsasi tasdiqlanmagan — xavfsizlik siyosati faollashtirilishi kerak");
  }
}

// ---------------------------------------------------------------------------
// Governance operations
// ---------------------------------------------------------------------------

export async function listMatrices(actor: AuthUser): Promise<Array<{ version: string; status: string; approvedBy: number | null; approvedAt: Date | null; rationale: string | null; createdAt: Date; definition: MatrixDefinition }>> {
  if (!can(actor.role, 'risk.matrix.approve') && !can(actor.role, 'services.view_all')) throw ApiError.forbidden();
  const rows = await db('risk_matrix_versions').orderBy('created_at', 'desc');
  return rows.map((r: Record<string, any>) => ({ version: r.version, status: r.status, approvedBy: r.approved_by, approvedAt: r.approved_at, rationale: r.rationale, createdAt: r.created_at, definition: JSON.parse(r.definition) }));
}

export async function createMatrixVersion(actor: AuthUser, version: string, definition: unknown, meta: RequestMeta): Promise<{ version: string }> {
  if (!can(actor.role, 'risk.matrix.approve')) throw ApiError.forbidden();
  if (!/^[a-zA-Z0-9._-]{1,32}$/.test(version)) throw ApiError.badRequest('Versiya nomi notogri', 'INVALID_VERSION');
  const problems = validateDefinition(definition);
  if (problems.length > 0) throw new ApiError(422, 'INVALID_MATRIX', 'Matritsa notogri', problems.map((p) => ({ code: 'INVALID', field: 'definition', message: p })));
  const existing = await db('risk_matrix_versions').where({ version }).first();
  if (existing) throw ApiError.conflict('Bu versiya allaqachon mavjud', 'VERSION_EXISTS');
  await db('risk_matrix_versions').insert({ version, definition: JSON.stringify(definition), status: 'DRAFT' });
  await logAudit({ userId: actor.id, action: 'RISK_MATRIX_CREATED', entityType: 'risk_matrix', entityId: version, newValue: { version, status: 'DRAFT' }, ...meta });
  return { version };
}

/**
 * Activates a DRAFT (or currently-ACTIVE) matrix with a mandatory rationale.
 * Serializes concurrent activations via a table row lock so exactly one matrix
 * is ACTIVE afterward; the previous ACTIVE is RETIRED (superseded). An ACTIVE
 * definition is never edited — a change requires a new version.
 */
export async function activateMatrix(actor: AuthUser, version: string, rationale: string, meta: RequestMeta): Promise<void> {
  if (!can(actor.role, 'risk.matrix.approve')) throw ApiError.forbidden();
  if (!rationale?.trim()) throw ApiError.badRequest('Tasdiqlash asosini (rationale) kiriting', 'RATIONALE_REQUIRED');

  await db.transaction(async (trx) => {
    const rows = await trx('risk_matrix_versions').forUpdate(); // lock all rows → serialize activations
    const target = rows.find((r: any) => r.version === version);
    if (!target) throw ApiError.notFound('Matritsa versiyasi topilmadi');
    if (target.status === 'RETIRED') throw ApiError.conflict('Chiqarib tashlangan matritsani faollashtirib bolmaydi', 'MATRIX_RETIRED');
    const problems = validateDefinition(JSON.parse(target.definition));
    if (problems.length > 0) throw new ApiError(422, 'INVALID_MATRIX', 'Matritsa notogri', problems.map((p) => ({ code: 'INVALID', field: 'definition', message: p })));

    for (const r of rows.filter((x: any) => x.status === 'ACTIVE' && x.version !== version)) {
      await trx('risk_matrix_versions').where({ id: r.id }).update({ status: 'RETIRED', superseded_by: target.id });
      await logAudit({ userId: actor.id, action: 'RISK_MATRIX_RETIRED', entityType: 'risk_matrix', entityId: r.version, oldValue: { status: 'ACTIVE' }, newValue: { status: 'RETIRED', supersededBy: version }, ...meta }, trx);
    }
    await trx('risk_matrix_versions').where({ id: target.id }).update({ status: 'ACTIVE', approved_by: actor.id, approved_at: trx.raw('CURRENT_TIMESTAMP(6)'), rationale: rationale.trim() });
    await logAudit({ userId: actor.id, action: 'RISK_MATRIX_ACTIVATED', entityType: 'risk_matrix', entityId: version, newValue: { version, rationale: rationale.trim() }, ...meta }, trx);
  });
}

export async function retireMatrix(actor: AuthUser, version: string, meta: RequestMeta): Promise<void> {
  if (!can(actor.role, 'risk.matrix.approve')) throw ApiError.forbidden();
  await db.transaction(async (trx) => {
    const row = await trx('risk_matrix_versions').where({ version }).forUpdate().first();
    if (!row) throw ApiError.notFound('Matritsa versiyasi topilmadi');
    if (row.status === 'RETIRED') return;
    // Retiring the only ACTIVE matrix leaves the domain fail-closed — that is a
    // SAFE outcome (safety ops refuse until a policy is activated again).
    await trx('risk_matrix_versions').where({ id: row.id }).update({ status: 'RETIRED' });
    await logAudit({ userId: actor.id, action: 'RISK_MATRIX_RETIRED', entityType: 'risk_matrix', entityId: version, oldValue: { status: row.status }, newValue: { status: 'RETIRED' }, ...meta }, trx);
  });
}
