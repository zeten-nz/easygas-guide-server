import { db } from '../../config/database';
import { ApiError } from '../../utils/errors';
import { logAudit } from '../audit/audit.service';
import type { AuthUser, BranchRow } from '../../types/auth';
import type { CreateBranchInput, UpdateBranchInput } from './branches.validators';

interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export interface BranchDetail {
  id: number;
  name: string;
  region: string;
  address: string | null;
  phone: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  userCount?: number;
  createdAt?: Date;
}

function toDetail(row: BranchRow & { created_at?: Date; user_count?: number | string }): BranchDetail {
  return {
    id: row.id,
    name: row.name,
    region: row.region,
    address: row.address,
    phone: row.phone,
    status: row.status,
    ...(row.user_count !== undefined ? { userCount: Number(row.user_count) } : {}),
    ...(row.created_at !== undefined ? { createdAt: row.created_at } : {}),
  };
}

/** Full management listing — all statuses, all fields, user counts. */
export async function listBranchesFull(): Promise<BranchDetail[]> {
  const rows = (await db('branches')
    .select('branches.*')
    .count({ user_count: 'users.id' })
    .leftJoin('users', function join() {
      this.on('users.branch_id', 'branches.id').andOnNull('users.deleted_at');
    })
    .groupBy('branches.id')
    .orderBy('branches.name')) as (BranchRow & { created_at: Date; user_count: number | string })[];
  return rows.map(toDetail);
}

/** Minimal public listing (sign-up form): ACTIVE branches, id/name/region only. */
export async function listBranchesPublic(): Promise<Pick<BranchDetail, 'id' | 'name' | 'region'>[]> {
  return db('branches').select('id', 'name', 'region').where({ status: 'ACTIVE' }).orderBy('name');
}

export async function getBranch(id: number): Promise<BranchDetail> {
  const row = (await db('branches').where({ id }).first()) as (BranchRow & { created_at: Date }) | undefined;
  if (!row) throw ApiError.notFound('Filial topilmadi');
  return toDetail(row);
}

async function assertNameAvailable(name: string, excludeId?: number): Promise<void> {
  const query = db('branches').whereRaw('LOWER(name) = LOWER(?)', [name]);
  if (excludeId !== undefined) query.whereNot({ id: excludeId });
  if (await query.first()) {
    throw ApiError.conflict('Bu nomdagi filial allaqachon mavjud', 'BRANCH_NAME_TAKEN');
  }
}

export async function createBranch(actor: AuthUser, input: CreateBranchInput, meta: RequestMeta): Promise<BranchDetail> {
  await assertNameAvailable(input.name);

  const id = await db.transaction(async (trx) => {
    const [newId] = await trx('branches').insert({
      name: input.name,
      region: input.region,
      address: input.address ?? null,
      phone: input.phone ?? null,
      status: 'ACTIVE',
    });
    await logAudit(
      {
        userId: actor.id,
        action: 'BRANCH_CREATED',
        entityType: 'branch',
        entityId: newId,
        newValue: { name: input.name, region: input.region },
        ...meta,
      },
      trx,
    );
    return newId as number;
  });

  return getBranch(id);
}

export async function updateBranch(
  actor: AuthUser,
  id: number,
  input: UpdateBranchInput,
  meta: RequestMeta,
): Promise<BranchDetail> {
  if (input.name !== undefined) await assertNameAvailable(input.name, id);

  await db.transaction(async (trx) => {
    const current = (await trx('branches').where({ id }).forUpdate().first()) as BranchRow | undefined;
    if (!current) throw ApiError.notFound('Filial topilmadi');

    const update: Record<string, unknown> = { updated_at: trx.fn.now() };
    const changes: Record<string, { old: unknown; new: unknown }> = {};
    for (const field of ['name', 'region', 'address', 'phone'] as const) {
      const next = input[field];
      if (next !== undefined && next !== current[field]) {
        update[field] = next;
        changes[field] = { old: current[field], new: next };
      }
    }

    if (Object.keys(changes).length > 0) {
      await trx('branches').where({ id }).update(update);
      await logAudit(
        { userId: actor.id, action: 'BRANCH_UPDATED', entityType: 'branch', entityId: id, newValue: changes, ...meta },
        trx,
      );
    }
  });

  return getBranch(id);
}

/**
 * Soft activation/deactivation only — branches referenced by users (and later
 * jobs) are never hard-deleted; the DB FK (RESTRICT) additionally refuses it.
 */
export async function setBranchStatus(
  actor: AuthUser,
  id: number,
  status: 'ACTIVE' | 'INACTIVE',
  meta: RequestMeta,
): Promise<BranchDetail> {
  await db.transaction(async (trx) => {
    const current = (await trx('branches').where({ id }).forUpdate().first()) as BranchRow | undefined;
    if (!current) throw ApiError.notFound('Filial topilmadi');
    if (current.status === status) {
      throw ApiError.conflict(
        status === 'ACTIVE' ? 'Filial allaqachon faol' : 'Filial allaqachon faolsizlantirilgan',
        'STATUS_UNCHANGED',
      );
    }

    await trx('branches').where({ id }).update({ status, updated_at: trx.fn.now() });
    await logAudit(
      {
        userId: actor.id,
        action: status === 'ACTIVE' ? 'BRANCH_ACTIVATED' : 'BRANCH_DEACTIVATED',
        entityType: 'branch',
        entityId: id,
        oldValue: { status: current.status },
        newValue: { status },
        ...meta,
      },
      trx,
    );
  });

  return getBranch(id);
}
