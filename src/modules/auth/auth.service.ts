import bcrypt from 'bcrypt';
import { db } from '../../config/database';
import { env } from '../../config/env';
import { ApiError } from '../../utils/errors';
import {
  generateOtp,
  generateResetToken,
  generateSessionToken,
  hashSessionToken,
  hmacSecret,
  timingSafeEqualHex,
} from '../../utils/crypto';
import { logAudit } from '../audit/audit.service';
import { getSmsProvider } from '../../sms';
import { logger } from '../../utils/logger';
import { toAuthUser, type UserWithRole } from '../users/user.mapper';
import type { AuthUser, PasswordResetRow, SessionRow } from '../../types/auth';
import type { LoginInput, RegisterInput } from './auth.validators';

const GENERIC_LOGIN_ERROR = "Telefon raqam yoki parol noto'g'ri";

/** Constant bcrypt hash compared against when the user does not exist, to equalize login timing. */
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer-not-a-real-password', 10);

interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

async function findUserByPhone(phone: string): Promise<UserWithRole | undefined> {
  return (await db('users')
    .select('users.*', 'roles.code as role_code')
    .join('roles', 'roles.id', 'users.role_id')
    .where('users.phone', phone)
    .whereNull('users.deleted_at')
    .first()) as UserWithRole | undefined;
}

// ---------------------------------------------------------------------------
// Login / sessions
// ---------------------------------------------------------------------------

export interface LoginResult {
  user: AuthUser;
  token: string;
  expiresAt: Date;
  rememberMe: boolean;
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

  const token = generateSessionToken();
  const ttlMs = input.rememberMe
    ? env.SESSION_REMEMBER_TTL_DAYS * 24 * 60 * 60 * 1000
    : env.SESSION_TTL_HOURS * 60 * 60 * 1000;
  const expiresAt = new Date(Date.now() + ttlMs);

  await db('sessions').insert({
    id: crypto.randomUUID(),
    user_id: user.id,
    token_hash: hashSessionToken(token),
    remember_me: input.rememberMe,
    expires_at: expiresAt,
    ip: meta.ip,
    user_agent: meta.userAgent,
  });

  await db('users').where({ id: user.id }).update({ last_login_at: db.fn.now() });

  await logAudit({ userId: user.id, action: 'LOGIN', entityType: 'user', entityId: user.id, ...meta });

  return { user: toAuthUser(user), token, expiresAt, rememberMe: input.rememberMe };
}

/** Revokes the session for the given raw cookie token. Safe to call with an invalid token. */
export async function logout(rawToken: string | undefined, meta: RequestMeta): Promise<void> {
  if (typeof rawToken !== 'string' || rawToken.length !== 64) return;

  const session = (await db('sessions')
    .where({ token_hash: hashSessionToken(rawToken) })
    .whereNull('revoked_at')
    .first()) as SessionRow | undefined;

  if (!session) return;

  await db('sessions').where({ id: session.id }).update({ revoked_at: db.fn.now() });
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

  // Any previous outstanding OTP for this user becomes invalid.
  await db('password_resets').where({ user_id: user.id }).whereNull('consumed_at').update({ consumed_at: db.fn.now() });

  await db('password_resets').insert({
    user_id: user.id,
    phone: user.phone,
    otp_hash: hmacSecret(otp),
    otp_expires_at: new Date(Date.now() + env.OTP_TTL_MINUTES * 60 * 1000),
    request_ip: meta.ip,
  });

  await logAudit({
    userId: user.id,
    action: 'PASSWORD_RESET_REQUESTED',
    entityType: 'user',
    entityId: user.id,
    ...meta,
  });

  try {
    await getSmsProvider().send(
      user.phone,
      `EASY GAS: parolni tiklash kodi: ${otp}. Kod ${env.OTP_TTL_MINUTES} daqiqa amal qiladi. Uni hech kimga bermang.`,
    );
  } catch (err) {
    logger.error({ err }, 'SMS delivery failed for password reset');
    // Still return the generic message — delivery failure must not reveal account existence.
  }

  return { message: GENERIC_OTP_SENT };
}

export async function verifyOtp(phone: string, otp: string): Promise<{ resetToken: string }> {
  const record = (await db('password_resets')
    .where({ phone })
    .whereNull('consumed_at')
    .orderBy('id', 'desc')
    .first()) as PasswordResetRow | undefined;

  if (!record || new Date(record.otp_expires_at).getTime() <= Date.now()) {
    throw ApiError.badRequest(GENERIC_OTP_ERROR, 'INVALID_OTP');
  }

  if (record.attempts >= env.OTP_MAX_ATTEMPTS) {
    throw ApiError.tooMany("Urinishlar soni oshib ketdi. Yangi kod so'rang.", 'OTP_ATTEMPTS_EXCEEDED');
  }

  await db('password_resets').where({ id: record.id }).increment('attempts', 1);

  if (!timingSafeEqualHex(record.otp_hash, hmacSecret(otp))) {
    throw ApiError.badRequest(GENERIC_OTP_ERROR, 'INVALID_OTP');
  }

  // OTP is single-use: consume it and hand out a short-lived reset token.
  const resetToken = generateResetToken();
  await db('password_resets')
    .where({ id: record.id })
    .update({
      consumed_at: db.fn.now(),
      reset_token_hash: hmacSecret(resetToken),
      reset_token_expires_at: new Date(Date.now() + env.RESET_TOKEN_TTL_MINUTES * 60 * 1000),
    });

  return { resetToken };
}

export async function resetPassword(resetToken: string, newPassword: string, meta: RequestMeta): Promise<void> {
  const record = (await db('password_resets')
    .where({ reset_token_hash: hmacSecret(resetToken) })
    .whereNull('reset_used_at')
    .first()) as PasswordResetRow | undefined;

  if (!record || !record.reset_token_expires_at || new Date(record.reset_token_expires_at).getTime() <= Date.now()) {
    throw ApiError.badRequest("Havola eskirgan. Qaytadan urinib ko'ring.", 'INVALID_RESET_TOKEN');
  }

  const passwordHash = await bcrypt.hash(newPassword, env.BCRYPT_ROUNDS);

  await db.transaction(async (trx) => {
    await trx('users').where({ id: record.user_id }).update({ password_hash: passwordHash });
    await trx('password_resets').where({ id: record.id }).update({ reset_used_at: trx.fn.now() });
    await trx('sessions').where({ user_id: record.user_id }).whereNull('revoked_at').update({ revoked_at: trx.fn.now() });
    await logAudit(
      { userId: record.user_id, action: 'PASSWORD_RESET', entityType: 'user', entityId: record.user_id, ...meta },
      trx,
    );
  });
}
