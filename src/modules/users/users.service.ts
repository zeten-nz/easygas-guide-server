import bcrypt from 'bcrypt';
import type { Knex } from 'knex';
import { db } from '../../config/database';
import { env } from '../../config/env';
import { ApiError } from '../../utils/errors';
import { logAudit } from '../audit/audit.service';
import { revokeAllSessions } from '../auth/auth.service';
import { BRANCH_REQUIRED_ROLES, getAssignableRoles, isBranchScoped } from '../../rbac/permissions';
import { toUserDetail, type UserDetail, type UserWithRoleBranch } from './user.mapper';
import type { AuthUser, RoleCode } from '../../types/auth';
import type { CreateUserInput, ListUsersQuery, UpdateUserInput } from './users.validators';

interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

const baseSelect = () =>
  db('users')
    .select('users.*', 'roles.code as role_code', 'branches.name as branch_name')
    .join('roles', 'roles.id', 'users.role_id')
    .leftJoin('branches', 'branches.id', 'users.branch_id')
    .whereNull('users.deleted_at');

async function findDetail(id: number): Promise<UserWithRoleBranch | undefined> {
  return (await baseSelect().where('users.id', id).first()) as UserWithRoleBranch | undefined;
}

/**
 * Validates the role/branch combination for create/update:
 * - the actor may only assign roles allowed by the centralized policy;
 * - branch-bound roles must reference an existing ACTIVE branch;
 * - RAHBAR (branch-scoped) may only place users into their own branch.
 * Returns the branch id to persist.
 */
async function resolveRoleAndBranch(
  actor: AuthUser,
  roleCode: RoleCode,
  branchId: number | null | undefined,
  trx?: Knex.Transaction,
): Promise<number | null> {
  if (!getAssignableRoles(actor.role).includes(roleCode)) {
    throw ApiError.forbidden("Bu rolni tayinlashga ruxsatingiz yo'q", 'ROLE_NOT_ALLOWED');
  }

  let resolvedBranchId = branchId ?? null;

  if (isBranchScoped(actor.role)) {
    if (!actor.branchId) {
      throw ApiError.forbidden("Sizga filial biriktirilmagan", 'NO_BRANCH');
    }
    if (resolvedBranchId !== null && resolvedBranchId !== actor.branchId) {
      throw ApiError.forbidden("Faqat o'z filialingizga foydalanuvchi qo'shishingiz mumkin", 'BRANCH_SCOPE');
    }
    resolvedBranchId = actor.branchId;
  }

  if (BRANCH_REQUIRED_ROLES.includes(roleCode) && resolvedBranchId === null) {
    throw ApiError.badRequest('Bu rol uchun filial tanlanishi shart', 'BRANCH_REQUIRED');
  }

  if (resolvedBranchId !== null) {
    const branch = await (trx ?? db)('branches').where({ id: resolvedBranchId, status: 'ACTIVE' }).first();
    if (!branch) {
      throw ApiError.badRequest('Tanlangan filial mavjud emas yoki faol emas', 'INVALID_BRANCH');
    }
  }

  return resolvedBranchId;
}

/**
 * Phase 10A: serializes every operation that can reduce the number of active
 * ADMIN users and returns the CURRENT active-admin id set. It uses a LOCKING
 * read (FOR UPDATE) over all active admin rows in a stable order (by id):
 *
 * - Two operations that both touch admins contend on this shared lock set, so
 *   the second one blocks until the first commits.
 * - When it unblocks, a locking read returns the LATEST COMMITTED rows — so
 *   the returned set already reflects the first operation's change. (A plain
 *   COUNT() would read the transaction's REPEATABLE-READ snapshot instead and
 *   miss it — the original last-admin race.)
 *
 * DB row locks work across processes (PM2 instances) — no process-local mutex.
 * The last-admin decision is then made from the returned set, not a separate
 * query, so it is always consistent with what was locked.
 */
async function lockActiveAdminIds(trx: Knex.Transaction): Promise<number[]> {
  const adminRole = await trx('roles').where({ code: 'ADMIN' }).first();
  if (!adminRole) return [];
  const rows = (await trx('users')
    .where({ role_id: adminRole.id, status: 'ACTIVE' })
    .whereNull('deleted_at')
    .orderBy('id')
    .forUpdate()
    .select('id')) as { id: number }[];
  return rows.map((r) => r.id);
}

/** Guard: refuse an action that would remove the last ACTIVE admin. */
function assertNotLastActiveAdmin(activeAdminIds: number[], targetUserId: number): void {
  if (activeAdminIds.filter((id) => id !== targetUserId).length === 0) {
    throw ApiError.conflict(
      "Tizimda oxirgi faol administratorni o'chirib bo'lmaydi",
      'LAST_ADMIN_PROTECTED',
    );
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface ListUsersResult {
  users: UserDetail[];
  total: number;
  page: number;
  limit: number;
}

export async function listUsers(actor: AuthUser, query: ListUsersQuery): Promise<ListUsersResult> {
  const build = () => {
    const q = baseSelect();
    // Branch-scoped actors (RAHBAR) only ever see their own branch.
    if (isBranchScoped(actor.role)) {
      q.where('users.branch_id', actor.branchId ?? -1);
    } else if (query.branchId) {
      q.where('users.branch_id', query.branchId);
    }
    if (query.role) q.where('roles.code', query.role);
    if (query.status) q.where('users.status', query.status);
    if (query.search) {
      // Plain LIKE is case-insensitive under the utf8mb4_unicode_ci collation.
      // (knex whereILike/whereLike inject COLLATE clauses invalid for utf8mb4.)
      const term = `%${query.search.replace(/[%_]/g, '\\$&')}%`;
      const phoneDigits = query.search.replace(/\D/g, '');
      q.where((sub) => {
        sub.where('users.first_name', 'like', term).orWhere('users.last_name', 'like', term);
        if (phoneDigits.length >= 4) sub.orWhere('users.phone', 'like', `%${phoneDigits}%`);
      });
    }
    return q;
  };

  const countRows = (await build()
    .clearSelect()
    .count({ count: '*' })) as unknown as [{ count: number | string }];
  const total = Number(countRows[0]?.count ?? 0);

  const rows = (await build()
    .orderBy('users.created_at', 'desc')
    .limit(query.limit)
    .offset((query.page - 1) * query.limit)) as UserWithRoleBranch[];

  return { users: rows.map(toUserDetail), total, page: query.page, limit: query.limit };
}

export async function getUser(actor: AuthUser, id: number): Promise<UserDetail> {
  const row = await findDetail(id);
  // Out-of-scope reads 404 (not 403) so IDs cannot be probed across branches.
  if (!row || (isBranchScoped(actor.role) && row.branch_id !== actor.branchId)) {
    throw ApiError.notFound('Foydalanuvchi topilmadi');
  }
  return toUserDetail(row);
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export async function createUser(actor: AuthUser, input: CreateUserInput, meta: RequestMeta): Promise<UserDetail> {
  const branchId = await resolveRoleAndBranch(actor, input.roleCode, input.branchId);

  const existing = await db('users').where({ phone: input.phone }).whereNull('deleted_at').first();
  if (existing) {
    throw ApiError.conflict('Bu telefon raqam bilan hisob allaqachon mavjud', 'PHONE_TAKEN');
  }

  const role = await db('roles').where({ code: input.roleCode }).first();
  if (!role) throw ApiError.badRequest("Rol noto'g'ri", 'INVALID_ROLE');

  const passwordHash = await bcrypt.hash(input.password, env.BCRYPT_ROUNDS);

  const id = await db.transaction(async (trx) => {
    const [newId] = await trx('users').insert({
      first_name: input.firstName,
      last_name: input.lastName,
      phone: input.phone,
      password_hash: passwordHash,
      region: input.region,
      branch_id: branchId,
      role_id: role.id,
      status: 'ACTIVE',
    });

    await logAudit(
      {
        userId: actor.id,
        action: 'USER_CREATED',
        entityType: 'user',
        entityId: newId,
        newValue: { phone: input.phone, role: input.roleCode, branchId, region: input.region },
        ...meta,
      },
      trx,
    );

    return newId as number;
  });

  return (await findDetail(id).then((r) => r && toUserDetail(r))) as UserDetail;
}

export async function updateUser(
  actor: AuthUser,
  id: number,
  input: UpdateUserInput,
  meta: RequestMeta,
): Promise<UserDetail> {
  if (input.roleCode !== undefined && id === actor.id) {
    // An admin never edits their own role — prevents accidentally removing
    // one's own administrative access (another admin must do it).
    throw ApiError.conflict("O'z rolingizni o'zingiz o'zgartira olmaysiz", 'SELF_ROLE_CHANGE');
  }

  await db.transaction(async (trx) => {
    // Role changes may demote an admin — serialize on the admin set FIRST
    // (consistent lock order: admin set → target row; see lockActiveAdminIds).
    let activeAdminIds: number[] | null = null;
    if (input.roleCode !== undefined) {
      activeAdminIds = await lockActiveAdminIds(trx);
    }

    const current = (await trx('users')
      .select('users.*', 'roles.code as role_code')
      .join('roles', 'roles.id', 'users.role_id')
      .where('users.id', id)
      .whereNull('users.deleted_at')
      .forUpdate()
      .first()) as (UserWithRoleBranch & { role_code: RoleCode }) | undefined;

    if (!current) throw ApiError.notFound('Foydalanuvchi topilmadi');

    const nextRole: RoleCode = input.roleCode ?? current.role_code;
    // branchId: undefined = keep current; null = clear (cross-branch roles only)
    const requestedBranch = input.branchId === undefined ? current.branch_id : input.branchId;

    if (input.roleCode !== undefined || input.branchId !== undefined) {
      if (current.role_code === 'ADMIN' && nextRole !== 'ADMIN') {
        assertNotLastActiveAdmin(activeAdminIds ?? (await lockActiveAdminIds(trx)), id);
      }
      await resolveRoleAndBranch(actor, nextRole, requestedBranch, trx);
    }

    if (input.phone !== undefined && input.phone !== current.phone) {
      const taken = await trx('users').where({ phone: input.phone }).whereNull('deleted_at').whereNot({ id }).first();
      if (taken) throw ApiError.conflict('Bu telefon raqam bilan hisob allaqachon mavjud', 'PHONE_TAKEN');
    }

    const update: Record<string, unknown> = { updated_at: trx.fn.now() };
    if (input.firstName !== undefined) update.first_name = input.firstName;
    if (input.lastName !== undefined) update.last_name = input.lastName;
    if (input.phone !== undefined) update.phone = input.phone;
    if (input.region !== undefined) update.region = input.region;
    if (input.branchId !== undefined) update.branch_id = input.branchId;
    if (input.roleCode !== undefined) {
      const role = await trx('roles').where({ code: input.roleCode }).first();
      if (!role) throw ApiError.badRequest("Rol noto'g'ri", 'INVALID_ROLE');
      update.role_id = role.id;
    }

    await trx('users').where({ id }).update(update);

    // Dedicated audit entries for security-relevant transitions; role/branch
    // changes take effect immediately because requireAuth reloads the user
    // from the database on every request.
    const auditBase = { userId: actor.id, entityType: 'user', entityId: id, ...meta } as const;

    if (input.roleCode !== undefined && input.roleCode !== current.role_code) {
      await logAudit(
        { ...auditBase, action: 'USER_ROLE_CHANGED', oldValue: { role: current.role_code }, newValue: { role: input.roleCode } },
        trx,
      );
    }
    if (input.branchId !== undefined && input.branchId !== current.branch_id) {
      await logAudit(
        { ...auditBase, action: 'USER_BRANCH_CHANGED', oldValue: { branchId: current.branch_id }, newValue: { branchId: input.branchId } },
        trx,
      );
    }

    const otherChanges: Record<string, { old: unknown; new: unknown }> = {};
    if (input.firstName !== undefined && input.firstName !== current.first_name)
      otherChanges.firstName = { old: current.first_name, new: input.firstName };
    if (input.lastName !== undefined && input.lastName !== current.last_name)
      otherChanges.lastName = { old: current.last_name, new: input.lastName };
    if (input.phone !== undefined && input.phone !== current.phone)
      otherChanges.phone = { old: current.phone, new: input.phone };
    if (input.region !== undefined && input.region !== current.region)
      otherChanges.region = { old: current.region, new: input.region };

    if (Object.keys(otherChanges).length > 0) {
      await logAudit({ ...auditBase, action: 'USER_UPDATED', newValue: otherChanges }, trx);
    }
  });

  return (await findDetail(id).then((r) => r && toUserDetail(r))) as UserDetail;
}

export async function blockUser(actor: AuthUser, id: number, meta: RequestMeta): Promise<UserDetail> {
  if (id === actor.id) {
    throw ApiError.conflict("O'zingizni bloklay olmaysiz", 'SELF_BLOCK');
  }

  await db.transaction(async (trx) => {
    // Blocking may remove an active admin — serialize on the admin set FIRST
    // (consistent lock order: admin set → target row; see lockActiveAdminIds).
    const activeAdminIds = await lockActiveAdminIds(trx);

    const current = (await trx('users')
      .select('users.*', 'roles.code as role_code')
      .join('roles', 'roles.id', 'users.role_id')
      .where('users.id', id)
      .whereNull('users.deleted_at')
      .forUpdate()
      .first()) as { status: string; role_code: RoleCode } | undefined;

    if (!current) throw ApiError.notFound('Foydalanuvchi topilmadi');
    if (current.status === 'BLOCKED') {
      throw ApiError.conflict('Foydalanuvchi allaqachon bloklangan', 'ALREADY_BLOCKED');
    }
    if (current.role_code === 'ADMIN') {
      assertNotLastActiveAdmin(activeAdminIds, id);
    }

    await trx('users').where({ id }).update({ status: 'BLOCKED', updated_at: trx.fn.now() });
    // Blocking kills every active session immediately, not just future logins.
    await trx('sessions').where({ user_id: id }).whereNull('revoked_at').update({ revoked_at: trx.fn.now() });

    await logAudit(
      {
        userId: actor.id,
        action: 'USER_BLOCKED',
        entityType: 'user',
        entityId: id,
        oldValue: { status: 'ACTIVE' },
        newValue: { status: 'BLOCKED' },
        ...meta,
      },
      trx,
    );
  });

  return (await findDetail(id).then((r) => r && toUserDetail(r))) as UserDetail;
}

export async function unblockUser(actor: AuthUser, id: number, meta: RequestMeta): Promise<UserDetail> {
  await db.transaction(async (trx) => {
    const current = (await trx('users')
      .where({ id })
      .whereNull('deleted_at')
      .forUpdate()
      .first()) as { status: string } | undefined;

    if (!current) throw ApiError.notFound('Foydalanuvchi topilmadi');
    if (current.status !== 'BLOCKED') {
      throw ApiError.conflict('Foydalanuvchi bloklanmagan', 'NOT_BLOCKED');
    }

    await trx('users').where({ id }).update({ status: 'ACTIVE', updated_at: trx.fn.now() });

    await logAudit(
      {
        userId: actor.id,
        action: 'USER_UNBLOCKED',
        entityType: 'user',
        entityId: id,
        oldValue: { status: 'BLOCKED' },
        newValue: { status: 'ACTIVE' },
        ...meta,
      },
      trx,
    );
  });

  return (await findDetail(id).then((r) => r && toUserDetail(r))) as UserDetail;
}

// Re-export so future admin flows (e.g. manual session revocation UI) have one entry point.
export { revokeAllSessions };
