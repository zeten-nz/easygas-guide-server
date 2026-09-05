/**
 * Phase 10D — server-authoritative, VERSIONED risk matrix (loyiha.md §21).
 *
 * The spec defines named risk levels (LOW / MEDIUM / HIGH / CRITICAL) and says a
 * risk is calculated from "checklist flags and technical validations" (§21) with
 * a per-step `risk_weight` (§14), and that a CRITICAL issue blocks completion
 * (§22 "no unresolved critical issue"). It does NOT define an exact
 * likelihood×severity threshold table, so this module provides one as an
 * explicit, VERSIONED policy — never magic numbers scattered through services.
 *
 * Only the backend maps (severity, likelihood, source) → level/score/blocking.
 * The client may propose a hazard/severity/likelihood but NEVER the level,
 * score, or blocking flag. A risk row records the `matrix_version` it was scored
 * under, so a future matrix change never rewrites the classification of old
 * safety records (they are re-read at their own version).
 */

export const RISK_MATRIX_VERSION = 'v1';

export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** Where a risk originated — some sources are inherently blocking safety events. */
export const RISK_SOURCES = ['MANUAL', 'STOP_REJECTED', 'MEASUREMENT_OUT_OF_RANGE', 'CHECKLIST_FLAG'] as const;
export type RiskSource = (typeof RISK_SOURCES)[number];

export const RISK_STATUSES = ['OPEN', 'MITIGATION_IN_PROGRESS', 'RESOLVED', 'REJECTED'] as const;
export type RiskStatus = (typeof RISK_STATUSES)[number];

export interface RiskInput {
  /** 1 (negligible) … 4 (catastrophic). */
  severity: number;
  /** 1 (rare) … 4 (frequent). */
  likelihood: number;
  source: RiskSource;
}

export interface RiskAssessment {
  matrixVersion: string;
  score: number;
  level: RiskLevel;
  blocking: boolean;
}

const MIN = 1;
const MAX = 4;

function clampInt(v: number): number {
  if (!Number.isFinite(v)) return MIN;
  return Math.min(MAX, Math.max(MIN, Math.round(v)));
}

/**
 * v1 policy (documented in docs/SAFETY-DOMAIN-10D.md):
 *   score = severity × likelihood  (range 1..16)
 *   score >= 12 → CRITICAL
 *   score >=  8 → HIGH
 *   score >=  4 → MEDIUM
 *   else        → LOW
 * Source overrides (safety-critical): a rejected STOP is always CRITICAL (a
 * safety checkpoint failed); a catastrophic-severity hazard (severity 4) is at
 * least HIGH regardless of likelihood.
 * Blocking = CRITICAL (matches §22's "no unresolved critical issue").
 */
export function computeRisk(input: RiskInput): RiskAssessment {
  const severity = clampInt(input.severity);
  const likelihood = clampInt(input.likelihood);
  const score = severity * likelihood;

  let level: RiskLevel;
  if (score >= 12) level = 'CRITICAL';
  else if (score >= 8) level = 'HIGH';
  else if (score >= 4) level = 'MEDIUM';
  else level = 'LOW';

  // Source-based safety overrides.
  if (input.source === 'STOP_REJECTED') level = 'CRITICAL';
  else if (severity === MAX && level !== 'CRITICAL') level = 'HIGH';

  return { matrixVersion: RISK_MATRIX_VERSION, score, level, blocking: level === 'CRITICAL' };
}

/** Whether a given level (as scored under its matrix version) blocks completion. */
export function isBlockingLevel(level: string): boolean {
  return level === 'CRITICAL';
}
