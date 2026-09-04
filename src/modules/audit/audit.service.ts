import type { Knex } from 'knex';
import type { Request } from 'express';
import { db } from '../../config/database';

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
  | 'EVIDENCE_INTEGRITY_FAILURE';

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
 * Writes an audit record. Pass `trx` to make the record part of a business
 * transaction (approval/rejection must be atomic with their audit entry).
 */
export async function logAudit(entry: AuditEntry, trx?: Knex.Transaction): Promise<void> {
  await (trx ?? db)('audit_logs').insert({
    user_id: entry.userId ?? null,
    action: entry.action,
    entity_type: entry.entityType ?? null,
    entity_id: entry.entityId != null ? String(entry.entityId) : null,
    old_value: entry.oldValue != null ? JSON.stringify(entry.oldValue) : null,
    new_value: entry.newValue != null ? JSON.stringify(entry.newValue) : null,
    ip: entry.ip ?? null,
    user_agent: entry.userAgent ?? null,
  });
}

export function requestMeta(req: Request): { ip: string | null; userAgent: string | null } {
  return {
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent']?.slice(0, 500) ?? null,
  };
}
