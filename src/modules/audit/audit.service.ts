import type { Knex } from 'knex';
import type { Request } from 'express';
import { db } from '../../config/database';
import { computeEntryHash, genesisHash, utcChainId } from './audit-chain';

export type AuditAction =
  | 'LOGIN'
  | 'LOGIN_FAILED'
  | 'LOGOUT'
  | 'REGISTRATION_REQUESTED'
  | 'USER_APPROVED'
  | 'USER_REJECTED'
  | 'PASSWORD_RESET_REQUESTED'
  | 'PASSWORD_RESET'
  | 'USER_CREATED'
  | 'USER_UPDATED'
  | 'USER_ROLE_CHANGED'
  | 'USER_BRANCH_CHANGED'
  | 'USER_BLOCKED'
  | 'USER_UNBLOCKED'
  | 'BRANCH_CREATED'
  | 'BRANCH_UPDATED'
  | 'BRANCH_ACTIVATED'
  | 'BRANCH_DEACTIVATED'
  | 'CUSTOMER_CREATED'
  | 'CUSTOMER_UPDATED'
  | 'VEHICLE_CREATED'
  | 'VEHICLE_UPDATED'
  | 'JOB_CREATED'
  | 'JOB_STARTED'
  | 'JOB_CANCELLED'
  | 'JOB_INSTALLATION_UPDATED'
  | 'TEMPLATE_CREATED'
  | 'TEMPLATE_VERSION_CREATED'
  | 'TEMPLATE_VERSION_PUBLISHED'
  | 'TEMPLATE_VERSION_ARCHIVED'
  | 'TEMPLATE_STEP_CHANGED'
  | 'CHECKLIST_ASSIGNED'
  | 'STEP_COMPLETED'
  | 'STOP_SUBMITTED'
  | 'STOP_APPROVED'
  | 'STOP_REJECTED'
  | 'STOP_CORRECTION_STARTED'
  | 'PHOTO_UPLOADED'
  | 'CUSTOMER_SIGNED'
  | 'JOB_CLOSED'
  | 'JOB_REOPENED'
  | 'QUALITY_REVIEW_REQUESTED'
  | 'STEP_CORRECTION_STARTED'
  | 'PHOTO_UPLOAD_STARTED'
  | 'PHOTO_UPLOAD_READY'
  | 'PHOTO_UPLOAD_FAILED'
  | 'SIGNATURE_UPLOAD_STARTED'
  | 'SIGNATURE_UPLOAD_FAILED'
  | 'SIGNATURE_SUPERSEDED'
  | 'EVIDENCE_VERIFIED'
  | 'EVIDENCE_INTEGRITY_FAILURE'
  // Phase 10D — safety domain
  | 'RISK_CREATED'
  | 'RISK_REVISED'
  | 'RISK_MITIGATION_SUBMITTED'
  | 'RISK_RESOLVED'
  | 'RISK_REOPENED'
  | 'RISK_OVERRIDE'
  | 'JOB_ASSIGNED'
  | 'JOB_REASSIGNED'
  | 'JOB_UNASSIGNED'
  | 'GPS_CAPTURED'
  | 'GPS_REJECTED'
  | 'GPS_OVERRIDE'
  | 'SIGNABLE_SUMMARY_PREPARED'
  | 'SIGNATURE_INVALIDATED'
  | 'COMPLETION_SNAPSHOT_FINALIZED'
  | 'LEGACY_SNAPSHOT_RECONSTRUCTED'
  | 'RISK_MATRIX_CREATED'
  | 'RISK_MATRIX_ACTIVATED'
  | 'RISK_MATRIX_RETIRED';

export interface AuditEntry {
  userId?: number | null;
  action: AuditAction;
  entityType?: string;
  entityId?: number | string;
  oldValue?: unknown;
  newValue?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Writes a tamper-evident audit record (Phase 10F). The row is linked into the
 * current UTC-day hash chain: the per-day head row is locked FOR UPDATE (so
 * concurrent appends serialize WITHIN the day only), the entry's `prev_hash`,
 * `chain_seq` and `entry_hash` are derived deterministically, and the head is
 * advanced — all in one transaction.
 *
 * Pass `trx` to make the record part of a business transaction (approval must be
 * atomic with its audit entry). When `trx` is given, the head lock is taken as
 * the LAST lock of that transaction; when omitted, logAudit runs its own short
 * transaction. `audit:verify` re-derives and checks the whole chain offline.
 */
export async function logAudit(entry: AuditEntry, trx?: Knex.Transaction): Promise<void> {
  if (trx) {
    await appendChained(trx, entry);
  } else {
    await db.transaction((t) => appendChained(t, entry));
  }
}

async function appendChained(trx: Knex.Transaction, entry: AuditEntry): Promise<void> {
  const chainId = utcChainId();
  // Ensure the per-day head row exists, then lock it (serializes same-day appends).
  await trx.raw(
    'INSERT INTO audit_chain_heads (chain_id, head_hash, head_seq) VALUES (?, ?, 0) ON DUPLICATE KEY UPDATE chain_id = chain_id',
    [chainId, genesisHash(chainId)],
  );
  const head = (await trx('audit_chain_heads').where({ chain_id: chainId }).forUpdate().first()) as {
    head_hash: string;
    head_seq: number | string;
  };
  const prevHash = head.head_hash;
  const chainSeq = Number(head.head_seq) + 1;
  const entityId = entry.entityId != null ? String(entry.entityId) : null;
  // ONE canonical UTC microsecond timestamp, taken inside this transaction, used
  // for BOTH the persisted created_at and the hash input — never re-derived at
  // verify time (so the event time is covered by the chain).
  const tsRes = (await trx.raw("SELECT DATE_FORMAT(UTC_TIMESTAMP(6), '%Y-%m-%d %H:%i:%s.%f') AS ts")) as [{ ts: string }[], unknown];
  const createdAt = tsRes[0][0].ts;
  const entryHash = computeEntryHash({
    chainId,
    chainSeq,
    prevHash,
    userId: entry.userId ?? null,
    action: entry.action,
    entityType: entry.entityType ?? null,
    entityId,
    oldValue: entry.oldValue ?? null,
    newValue: entry.newValue ?? null,
    ip: entry.ip ?? null,
    userAgent: entry.userAgent ?? null,
    createdAt,
  });
  await trx('audit_logs').insert({
    user_id: entry.userId ?? null,
    action: entry.action,
    entity_type: entry.entityType ?? null,
    entity_id: entityId,
    old_value: entry.oldValue != null ? JSON.stringify(entry.oldValue) : null,
    new_value: entry.newValue != null ? JSON.stringify(entry.newValue) : null,
    ip: entry.ip ?? null,
    user_agent: entry.userAgent ?? null,
    created_at: createdAt,
    chain_id: chainId,
    chain_seq: chainSeq,
    prev_hash: prevHash,
    entry_hash: entryHash,
  });
  await trx('audit_chain_heads')
    .where({ chain_id: chainId })
    .update({ head_hash: entryHash, head_seq: chainSeq, updated_at: trx.raw('CURRENT_TIMESTAMP(6)') });
}

export function requestMeta(req: Request): { ip: string | null; userAgent: string | null } {
  return {
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent']?.slice(0, 500) ?? null,
  };
}
