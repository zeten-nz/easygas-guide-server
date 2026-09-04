import bcrypt from 'bcrypt';
import { db } from '../../config/database';
import { env } from '../../config/env';
import { ApiError } from '../../utils/errors';
import {
  generateOtp,
  generateResetToken,
  hmacSecret,
  timingSafeEqualHex,
} from '../../utils/crypto';
import { logAudit } from '../audit/audit.service';
import { createSession, revokeByToken } from './session.service';
import { enqueueOtpSms } from '../../sms/outbox.service';
import { toAuthUser, type UserWithRole } from '../users/user.mapper';
import type { AuthUser, PasswordResetRow } from '../../types/auth';
import type { LoginInput, RegisterInput } from './auth.validators';

const GENERIC_LOGIN_ERROR = "Telefon raqam yoki parol noto'g'ri";

/** Constant bcrypt hash compared against when the user does not exist, to equalize login timing. */
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer-not-a-real-password', 10);

interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

async function findUserByPhone(phone: string): Promise<(UserWithRole & { branch_status: string | null }) | undefined> {
  return (await db('users')
    .select('users.*', 'roles.code as role_code', 'branches.status as branch_status')
    .join('roles', 'roles.id', 'users.role_id')
    .leftJoin('branches', 'branches.id', 'users.branch_id')
    .where('users.phone', phone)
    .whereNull('users.deleted_at')
    .first()) as (UserWithRole & { branch_status: string | null }) | undefined;
}

// ---------------------------------------------------------------------------
// Login / sessions
// ---------------------------------------------------------------------------

export interface LoginResult {
  user: AuthUser;
  token: string;
  expiresAt: Date;
  rememberMe: boolean;
  rotationSeq: number;
}

export async function login(input: LoginInput, meta: RequestMeta): Promise<LoginResult> {
  const user = await findUserByPhone(input.phone);

  if (!user) {
    // Same failure path cost as a wrong password — prevents account enumeration by timing.
    await bcrypt.compare(input.password, DUMMY_HASH);
    throw ApiError.unauthorized(GENERIC_LOGIN_ERROR, 'INVALID_CREDENTIALS');
  }

  const passwordOk = await bcrypt.compare(input.password, user.password_hash);
  if (!passwordOk) {
    await logAudit({
      userId: user.id,
      action: 'LOGIN_FAILED',
      entityType: 'user',
      entityId: user.id,
      ...meta,
    });
    throw ApiError.unauthorized(GENERIC_LOGIN_ERROR, 'INVALID_CREDENTIALS');
  }

  if (user.status !== 'ACTIVE') {
    // Blocked/inactive accounts get the same generic failure as bad credentials,
    // so a blocked user cannot confirm their password is still valid.
    // The audit trail keeps the real reason.
    await logAudit({
      userId: user.id,
      action: 'LOGIN_FAILED',
      entityType: 'user',
      entityId: user.id,
      newValue: { reason: 'ACCOUNT_INACTIVE' },
      ...meta,
    });
    throw ApiError.unauthorized(GENERIC_LOGIN_ERROR, 'INVALID_CREDENTIALS');
  }

  // Phase 10A branch policy: a deactivated branch means no new sessions for
  // its users — same generic failure as above, real reason in the audit only.
  if (user.branch_id !== null && user.branch_status !== 'ACTIVE') {
    await logAudit({
      userId: user.id,
      action: 'LOGIN_FAILED',
      entityType: 'user',
      entityId: user.id,
      newValue: { reason: 'BRANCH_INACTIVE', branchId: user.branch_id },
      ...meta,
    });
    throw ApiError.unauthorized(GENERIC_LOGIN_ERROR, 'INVALID_CREDENTIALS');
  }

  // Phase 10C: creates a session FAMILY with absolute/idle caps; the token
  // rotates on later requests. The cookie's absolute expiry is returned for the
  // Set-Cookie maxAge.
  const created = await createSession(user.id, input.rememberMe, meta);

  await db('users').where({ id: user.id }).update({ last_login_at: db.fn.now() });

  await logAudit({ userId: user.id, action: 'LOGIN', entityType: 'user', entityId: user.id, ...meta });

  return {
    user: toAuthUser(user),
    token: created.token,
    expiresAt: created.absoluteExpiresAt,
    rememberMe: input.rememberMe,
    rotationSeq: created.rotationSeq,
  };
}

/** Revokes the session (family) for the given raw cookie token. Safe with an invalid token. */
export async function logout(rawToken: string | undefined, meta: RequestMeta): Promise<void> {
  const session = await revokeByToken(rawToken);
  if (!session) return;
  await logAudit({
    userId: session.user_id,
    action: 'LOGOUT',
    entityType: 'session',
    entityId: session.id,
    ...meta,
  });
}

/** Used by password reset (and later by admin block) to kill every session of a user. */
export async function revokeAllSessions(userId: number): Promise<number> {
  return db('sessions').where({ user_id: userId }).whereNull('revoked_at').update({ revoked_at: db.fn.now() });
}

// ---------------------------------------------------------------------------
// Registration request
// ---------------------------------------------------------------------------

export async function createRegistrationRequest(input: RegisterInput, meta: RequestMeta): Promise<{ id: number }> {
  const branch = await db('branches').where({ id: input.branchId, status: 'ACTIVE' }).first();
  if (!branch) {
    throw ApiError.badRequest("Tanlangan servis filiali mavjud emas", 'INVALID_BRANCH');
  }

  const existingUser = await db('users').where({ phone: input.phone }).whereNull('deleted_at').first();
  if (existingUser) {
    throw ApiError.conflict("Bu telefon raqam bilan hisob allaqachon mavjud", 'PHONE_TAKEN');
  }

  const pendingRequest = await db('registration_requests')
    .where({ phone: input.phone, status: 'PENDING' })
    .first();
  if (pendingRequest) {
    throw ApiError.conflict("Bu raqam uchun so'rov allaqachon yuborilgan va ko'rib chiqilmoqda", 'REQUEST_PENDING');
  }

  const passwordHash = await bcrypt.hash(input.password, env.BCRYPT_ROUNDS);

  const [id] = await db('registration_requests').insert({
    first_name: input.firstName,
    last_name: input.lastName,
    phone: input.phone,
    region: input.region,
    branch_id: input.branchId,
    comment: input.comment ?? null,
    password_hash: passwordHash,
    status: 'PENDING',
  });

  await logAudit({
    action: 'REGISTRATION_REQUESTED',
    entityType: 'registration_request',
    entityId: id,
    newValue: { phone: input.phone, branchId: input.branchId },
    ...meta,
  });

  return { id: id as number };
}

// ---------------------------------------------------------------------------
// Password reset (OTP)
// ---------------------------------------------------------------------------

const GENERIC_OTP_SENT = "Agar bu raqam tizimda mavjud bo'lsa, SMS kod yuborildi";
const GENERIC_OTP_ERROR = "Kod noto'g'ri yoki muddati tugagan";

/**
 * Starts the reset flow. Always resolves with a generic message — the caller
 * must not be able to tell whether the phone exists (no enumeration).
 */
export async function requestPasswordReset(phone: string, meta: RequestMeta): Promise<{ message: string }> {
  const user = await findUserByPhone(phone);
  if (!user || user.status !== 'ACTIVE') {
    return { message: GENERIC_OTP_SENT };
  }

  const otp = generateOtp();

  // Phase 10C OTP lifecycle: the OTP is hashed at rest, and its validity window
  // starts at CREATION (not at SMS acceptance) — a consistent, documented
  // policy. Superseding + enqueuing happen in one transaction so concurrent
  // resend requests cannot leave two verifiable OTPs, and no message is queued
  // for an OTP that was not persisted. The queued SMS body is encrypted at rest
  // (never plaintext) and is cancelled rather than delivered if it becomes older
  // than SMS_MAX_AGE_SECONDS.
  await db.transaction(async (trx) => {
    // Invalidate previous outstanding OTPs AND cancel their still-pending SMS.
    await trx('password_resets').where({ user_id: user.id }).whereNull('consumed_at').update({ consumed_at: trx.fn.now() });

    await trx('password_resets').insert({
      user_id: user.id,
      phone: user.phone,
      otp_hash: hmacSecret(otp),
      otp_expires_at: new Date(Date.now() + env.OTP_TTL_MINUTES * 60 * 1000),
      request_ip: meta.ip,
    });

    await logAudit(
      { userId: user.id, action: 'PASSWORD_RESET_REQUESTED', entityType: 'user', entityId: user.id, ...meta },
      trx,
    );

    // The OTP itself never appears in the audit or logs — only the enqueue does.
    await enqueueOtpSms(trx, {
      userId: user.id,
      phone: user.phone,
      message: `EASY GAS: parolni tiklash kodi: ${otp}. Kod ${env.OTP_TTL_MINUTES} daqiqa amal qiladi. Uni hech kimga bermang.`,
    });
  });

  return { message: GENERIC_OTP_SENT };
}

export async function verifyOtp(phone: string, otp: string): Promise<{ resetToken: string }> {
  // Phase 10A: the whole check/increment/consume sequence runs atomically on a
  // row-locked record — concurrent requests serialize, so the attempt limit
  // cannot be overrun and a correct OTP is consumed exactly once. Crucially the
  // transaction ALWAYS commits (the attempt increment must survive a wrong
  // guess — a rolled-back increment would defeat brute-force protection), so
  // the outcome is returned and any error is thrown AFTER the commit.
  const outcome = await db.transaction(
    async (trx): Promise<{ kind: 'ok'; resetToken: string } | { kind: 'invalid' } | { kind: 'too_many' }> => {
      const record = (await trx('password_resets')
        .where({ phone })
        .whereNull('consumed_at')
        .orderBy('id', 'desc')
        .forUpdate()
        .first()) as PasswordResetRow | undefined;

      if (!record || new Date(record.otp_expires_at).getTime() <= Date.now()) {
        return { kind: 'invalid' };
      }
      if (record.attempts >= env.OTP_MAX_ATTEMPTS) {
        return { kind: 'too_many' };
      }

      // Increment first and let it COMMIT regardless of the match result.
      await trx('password_resets').where({ id: record.id }).increment('attempts', 1);

      if (!timingSafeEqualHex(record.otp_hash, hmacSecret(otp))) {
        return { kind: 'invalid' };
      }

      // OTP is single-use: consume it and hand out a short-lived reset token.
      const resetToken = generateResetToken();
      await trx('password_resets')
        .where({ id: record.id })
        .update({
          consumed_at: trx.fn.now(),
          reset_token_hash: hmacSecret(resetToken),
          reset_token_expires_at: new Date(Date.now() + env.RESET_TOKEN_TTL_MINUTES * 60 * 1000),
        });

      return { kind: 'ok', resetToken };
    },
  );

  if (outcome.kind === 'too_many') {
    throw ApiError.tooMany("Urinishlar soni oshib ketdi. Yangi kod so'rang.", 'OTP_ATTEMPTS_EXCEEDED');
  }
  if (outcome.kind === 'invalid') {
    throw ApiError.badRequest(GENERIC_OTP_ERROR, 'INVALID_OTP');
  }
  return { resetToken: outcome.resetToken };
}

export async function resetPassword(resetToken: string, newPassword: string, meta: RequestMeta): Promise<void> {
  // The hash is computed before the transaction so the row lock is held only
  // for the short atomic section (bcrypt at cost 12 takes ~250ms).
  const passwordHash = await bcrypt.hash(newPassword, env.BCRYPT_ROUNDS);

  // Phase 10A: single atomic boundary — the token row is locked and its
  // single-use state re-validated INSIDE the transaction, so two concurrent
  // requests with the same token can never both succeed: the loser blocks on
  // the row lock, re-reads reset_used_at as set, and gets the generic error.
  // Password update + token consumption + session revocation + audit commit
  // together or not at all.
  await db.transaction(async (trx) => {
    const record = (await trx('password_resets')
      .where({ reset_token_hash: hmacSecret(resetToken) })
      .forUpdate()
      .first()) as PasswordResetRow | undefined;

    if (
      !record ||
      record.reset_used_at !== null ||
      !record.reset_token_expires_at ||
      new Date(record.reset_token_expires_at).getTime() <= Date.now()
    ) {
      throw ApiError.badRequest("Havola eskirgan. Qaytadan urinib ko'ring.", 'INVALID_RESET_TOKEN');
    }

    await trx('users').where({ id: record.user_id }).update({ password_hash: passwordHash });
    await trx('password_resets').where({ id: record.id }).update({ reset_used_at: trx.fn.now() });
    await trx('sessions').where({ user_id: record.user_id }).whereNull('revoked_at').update({ revoked_at: trx.fn.now() });
    await logAudit(
      { userId: record.user_id, action: 'PASSWORD_RESET', entityType: 'user', entityId: record.user_id, ...meta },
      trx,
    );
  });
}
