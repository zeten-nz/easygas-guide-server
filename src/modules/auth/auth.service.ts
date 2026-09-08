import bcrypt from 'bcrypt';
import { db } from '../../config/database';
import { env } from '../../config/env';
import { ApiError } from '../../utils/errors';
import { logAudit } from '../audit/audit.service';
import { createSession, revokeByToken, type CreatedSession } from './session.service';
import { toAuthUser, type UserWithRole } from '../users/user.mapper';
import type { AuthUser, UserRow } from '../../types/auth';
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

async function findUserById(id: number): Promise<(UserWithRole & { branch_status: string | null }) | undefined> {
  return (await db('users')
    .select('users.*', 'roles.code as role_code', 'branches.status as branch_status')
    .join('roles', 'roles.id', 'users.role_id')
    .leftJoin('branches', 'branches.id', 'users.branch_id')
    .where('users.id', id)
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

  // The authoritative credential check AND the session insert run as ONE atomic,
  // row-locked unit — closing the analogous credential-check → session-insert gap
  // (a concurrent admin reset/block could otherwise run its revoke-all BETWEEN a
  // pre-lock password check and a post-check session insert, leaving the fresh
  // session alive). The password is verified against the LOCKED hash, so a reset
  // that committed first makes the now-stale password fail here. On success the
  // session is committed with the login; a reset that lands after locks the same
  // row and its revoke-all catches this session. Lock order (user row → sessions →
  // audit chain) matches admin reset + change-password, so no deadlock is possible.
  type Outcome =
    | { kind: 'ok'; created: CreatedSession; mustChangePassword: boolean }
    | { kind: 'invalid' }
    | { kind: 'temp_expired' };

  const outcome = await db.transaction(async (trx): Promise<Outcome> => {
    const row = (await trx('users').where({ id: user.id }).whereNull('deleted_at').forUpdate().first()) as
      | UserRow
      | undefined;
    if (!row) return { kind: 'invalid' };

    const auditFail = (newValue?: Record<string, unknown>): Promise<unknown> =>
      logAudit(
        { userId: user.id, action: 'LOGIN_FAILED', entityType: 'user', entityId: user.id, ...(newValue ? { newValue } : {}), ...meta },
        trx,
      );

    if (!(await bcrypt.compare(input.password, row.password_hash))) {
      await auditFail();
      return { kind: 'invalid' };
    }
    // Blocked/inactive accounts get the same generic failure as bad credentials,
    // so a blocked user cannot confirm their password is still valid. The audit
    // trail keeps the real reason.
    if (row.status !== 'ACTIVE') {
      await auditFail({ reason: 'ACCOUNT_INACTIVE' });
      return { kind: 'invalid' };
    }
    // Phase 10A branch policy: a deactivated branch means no new sessions for its
    // users. (Branch status comes from the pre-lock join; branch deactivation is a
    // separate flow that revokes sessions and is re-checked live by requireAuth.)
    if (user.branch_id !== null && user.branch_status !== 'ACTIVE') {
      await auditFail({ reason: 'BRANCH_INACTIVE', branchId: user.branch_id });
      return { kind: 'invalid' };
    }
    // §D — an EXPIRED temporary password is no longer a usable credential (checked
    // on the LOCKED row). Only fires after a correct password + ACTIVE status, so
    // it is the legitimate employee being told to obtain a fresh temporary password.
    if (
      row.must_change_password &&
      row.temp_password_expires_at &&
      new Date(row.temp_password_expires_at).getTime() <= Date.now()
    ) {
      await auditFail({ reason: 'TEMP_PASSWORD_EXPIRED' });
      return { kind: 'temp_expired' };
    }

    // Phase 10C: creates a session FAMILY with absolute/idle caps, INSIDE this
    // transaction so it commits atomically with the credential check.
    const created = await createSession(user.id, input.rememberMe, meta, trx);
    await trx('users').where({ id: user.id }).update({ last_login_at: trx.fn.now() });
    await logAudit({ userId: user.id, action: 'LOGIN', entityType: 'user', entityId: user.id, ...meta }, trx);
    return { kind: 'ok', created, mustChangePassword: Boolean(row.must_change_password) };
  });

  if (outcome.kind === 'invalid') {
    throw ApiError.unauthorized(GENERIC_LOGIN_ERROR, 'INVALID_CREDENTIALS');
  }
  if (outcome.kind === 'temp_expired') {
    throw ApiError.unauthorized(
      "Vaqtinchalik parol muddati tugagan. Administratordan yangi parol so'rang.",
      'TEMP_PASSWORD_EXPIRED',
    );
  }

  return {
    // Reflect the authoritative must_change_password from the locked row (a reset
    // could have set it just before this login matched the new temp password).
    user: toAuthUser({ ...user, must_change_password: outcome.mustChangePassword }),
    token: outcome.created.token,
    expiresAt: outcome.created.absoluteExpiresAt,
    rememberMe: input.rememberMe,
    rotationSeq: outcome.created.rotationSeq,
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
// Authenticated password change (§D — first-login and voluntary change)
// ---------------------------------------------------------------------------

export interface ChangePasswordResult {
  user: AuthUser;
  token: string;
  expiresAt: Date;
  rememberMe: boolean;
  rotationSeq: number;
}

/**
 * Authenticated self password change. This is the ONLY way out of the §D
 * first-login restriction imposed on a temporary-password session: the employee
 * supplies their current (temporary) password and a new one that satisfies the
 * standard password policy (validated at the router).
 *
 * Guarantees:
 *  - the user row is locked FOR UPDATE and RE-READ inside the transaction, and the
 *    current password is verified against THAT locked hash — so a concurrent admin
 *    reset (which also locks this row) can never interleave to leave a lost update
 *    or an unrestricted session on stale credentials: either this change commits
 *    first (and the admin reset then re-restricts on top of it), or the reset
 *    commits first (and the now-stale temporary password fails verification here);
 *  - authoritative temp-password expiry re-check on the locked row — an expired
 *    temporary password cannot be "upgraded" into a permanent one;
 *  - the current password is verified (constant-time bcrypt), and the new one is
 *    rejected if it equals the current/temporary password (no reuse);
 *  - password update + revocation of EVERY existing session/family + audit commit
 *    atomically; the restriction (must_change_password) is cleared only on that
 *    committed change;
 *  - a brand-new session family is then minted so the caller can rotate the
 *    cookie + CSRF token (the just-used temporary-password session is dead). If a
 *    reset lands after this commit, requireAuth re-reads must_change_password on
 *    every request, so the fresh session is immediately re-restricted.
 * The audit entry records the actor only — never the old or new password.
 */
export async function changePassword(
  actor: AuthUser,
  currentPassword: string,
  newPassword: string,
  meta: RequestMeta,
): Promise<ChangePasswordResult> {
  // Hash the NEW password before the transaction — it does not depend on the row,
  // so the row lock below is held only for the short verify+write section, not for
  // the ~250ms bcrypt hash.
  const passwordHash = await bcrypt.hash(newPassword, env.BCRYPT_ROUNDS);

  const created = await db.transaction(async (trx) => {
    const row = (await trx('users').where({ id: actor.id }).whereNull('deleted_at').forUpdate().first()) as
      | UserRow
      | undefined;
    // requireAuth already re-validated the account this request; a missing row here
    // means it was removed mid-request — treat as unauthenticated.
    if (!row) throw ApiError.unauthorized();

    // Authoritative expiry check on the LOCKED row (§D): reject even if a session
    // was minted just before the temporary password expired.
    if (
      row.must_change_password &&
      row.temp_password_expires_at &&
      new Date(row.temp_password_expires_at).getTime() <= Date.now()
    ) {
      throw ApiError.unauthorized(
        "Vaqtinchalik parol muddati tugagan. Administratordan yangi parol so'rang.",
        'TEMP_PASSWORD_EXPIRED',
      );
    }

    // Verify the current password against the LOCKED hash (never a pre-read copy),
    // so a reset that committed first makes the stale temporary password fail here.
    const currentOk = await bcrypt.compare(currentPassword, row.password_hash);
    if (!currentOk) {
      throw ApiError.badRequest("Joriy parol noto'g'ri", 'INVALID_CURRENT_PASSWORD');
    }

    // The new password must differ from the current/temporary one.
    const sameAsCurrent = await bcrypt.compare(newPassword, row.password_hash);
    if (sameAsCurrent) {
      throw ApiError.badRequest('Yangi parol avvalgisidan farq qilishi kerak', 'PASSWORD_REUSE');
    }

    await trx('users').where({ id: actor.id }).update({
      password_hash: passwordHash,
      must_change_password: false,
      temp_password_expires_at: null,
      updated_at: trx.fn.now(),
    });
    // Credential update, revoke-all, AND the replacement session are ONE atomic
    // unit under the user-row lock. Kill every existing session/family (including
    // the one that made THIS request) and mint the fresh family INSIDE the same
    // transaction: an admin reset that lands after this commit is strictly
    // serialized (it locks the same row), so its own revoke-all catches this
    // just-created session — a stale/replacement session can never outlive an
    // intervening reset. The cookie is issued only after this commit (controller).
    await trx('sessions').where({ user_id: actor.id }).whereNull('revoked_at').update({ revoked_at: trx.fn.now() });
    // audit last — consistent lock order (user row → sessions → audit chain).
    await logAudit(
      { userId: actor.id, action: 'PASSWORD_CHANGED', entityType: 'user', entityId: actor.id, ...meta },
      trx,
    );
    // Non-persistent by design — a fresh explicit login re-establishes "remember
    // me" if wanted. CSRF is derived from the token by the controller.
    return createSession(actor.id, false, meta, trx);
  });

  const fresh = await findUserById(actor.id);
  return {
    user: toAuthUser(fresh!),
    token: created.token,
    expiresAt: created.absoluteExpiresAt,
    rememberMe: false,
    rotationSeq: created.rotationSeq,
  };
}
