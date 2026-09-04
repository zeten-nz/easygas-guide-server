import { db } from '../../config/database';
import { ApiError } from '../../utils/errors';
import { logAudit } from '../audit/audit.service';
import { getSmsProvider } from '../../sms';
import { logger } from '../../utils/logger';
import type { RegistrationRequestRow, RegistrationStatus, RoleCode } from '../../types/auth';

interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export async function listRegistrationRequests(status?: RegistrationStatus) {
  const query = db('registration_requests as rr')
    .select(
      'rr.id',
      'rr.first_name',
      'rr.last_name',
      'rr.phone',
      'rr.region',
      'rr.branch_id',
      'b.name as branch_name',
      'rr.comment',
      'rr.status',
      'rr.reject_reason',
      'rr.reviewed_at',
      'rr.created_at',
    )
    .join('branches as b', 'b.id', 'rr.branch_id')
    .orderBy('rr.created_at', 'desc')
    .limit(200);

  if (status) query.where('rr.status', status);

  const rows = await query;
  return rows.map((r: Record<string, unknown>) => ({
    id: r.id,
    firstName: r.first_name,
    lastName: r.last_name,
    phone: r.phone,
    region: r.region,
    branchId: r.branch_id,
    branchName: r.branch_name,
    comment: r.comment,
    status: r.status,
    rejectReason: r.reject_reason,
    reviewedAt: r.reviewed_at,
    createdAt: r.created_at,
  }));
}

/**
 * Approves a PENDING request inside a transaction:
 * locks the request row, creates the active user with the chosen role,
 * marks the request APPROVED and writes the audit entry atomically.
 */
export async function approveRegistrationRequest(
  requestId: number,
  roleCode: RoleCode,
  adminId: number,
  meta: RequestMeta,
): Promise<{ userId: number }> {
  const userId = await db.transaction(async (trx) => {
    const request = (await trx('registration_requests')
      .where({ id: requestId })
      .forUpdate()
      .first()) as RegistrationRequestRow | undefined;

    if (!request) throw ApiError.notFound("So'rov topilmadi");
    if (request.status !== 'PENDING') {
      throw ApiError.conflict("Bu so'rov allaqachon ko'rib chiqilgan", 'ALREADY_REVIEWED');
    }

    const existingUser = await trx('users').where({ phone: request.phone }).whereNull('deleted_at').first();
    if (existingUser) {
      throw ApiError.conflict('Bu telefon raqam bilan hisob allaqachon mavjud', 'PHONE_TAKEN');
    }

    const role = await trx('roles').where({ code: roleCode }).first();
    if (!role) throw ApiError.badRequest("Rol noto'g'ri", 'INVALID_ROLE');

    const [newUserId] = await trx('users').insert({
      first_name: request.first_name,
      last_name: request.last_name,
      phone: request.phone,
      password_hash: request.password_hash,
      region: request.region,
      branch_id: request.branch_id,
      role_id: role.id,
      status: 'ACTIVE',
    });

    await trx('registration_requests').where({ id: requestId }).update({
      status: 'APPROVED',
      reviewed_by: adminId,
      reviewed_at: trx.fn.now(),
      created_user_id: newUserId,
    });

    await logAudit(
      {
        userId: adminId,
        action: 'USER_APPROVED',
        entityType: 'registration_request',
        entityId: requestId,
        oldValue: { status: 'PENDING' },
        newValue: { status: 'APPROVED', userId: newUserId, role: roleCode },
        ...meta,
      },
      trx,
    );

    return newUserId as number;
  });

  // Notification is best-effort — approval must not fail if SMS delivery does.
  try {
    const request = await db('registration_requests').where({ id: requestId }).first();
    await getSmsProvider().send(
      request.phone,
      "EASY GAS: hisobingiz tasdiqlandi. Endi telefon raqamingiz va parolingiz bilan tizimga kirishingiz mumkin.",
    );
  } catch (err) {
    logger.error({ err }, 'SMS delivery failed for registration approval');
  }

  return { userId };
}

export async function rejectRegistrationRequest(
  requestId: number,
  reason: string,
  adminId: number,
  meta: RequestMeta,
): Promise<void> {
  await db.transaction(async (trx) => {
    const request = (await trx('registration_requests')
      .where({ id: requestId })
      .forUpdate()
      .first()) as RegistrationRequestRow | undefined;

    if (!request) throw ApiError.notFound("So'rov topilmadi");
    if (request.status !== 'PENDING') {
      throw ApiError.conflict("Bu so'rov allaqachon ko'rib chiqilgan", 'ALREADY_REVIEWED');
    }

    await trx('registration_requests').where({ id: requestId }).update({
      status: 'REJECTED',
      reviewed_by: adminId,
      reviewed_at: trx.fn.now(),
      reject_reason: reason,
    });

    await logAudit(
      {
        userId: adminId,
        action: 'USER_REJECTED',
        entityType: 'registration_request',
        entityId: requestId,
        oldValue: { status: 'PENDING' },
        newValue: { status: 'REJECTED', reason },
        ...meta,
      },
      trx,
    );
  });
}
