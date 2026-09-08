import type { Knex } from 'knex';
import { db } from '../../config/database';
import { ApiError } from '../../utils/errors';
import { logAudit } from '../audit/audit.service';
import { normalizeName } from '../catalog/normalize';
import { REFERENCE_KINDS, type ReferenceKind } from './reference.config';
import type { AuthUser } from '../../types/auth';

interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export type RefStatus = 'ACTIVE' | 'ARCHIVED';

export interface ReferenceDetail {
  id: number;
  name: string;
  code: string | null;
  status: RefStatus;
  inUseCount: number;
  deletable: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListReferenceQuery {
  page: number;
  limit: number;
  search?: string;
  status?: RefStatus;
}

export interface ListReferenceResult {
  items: ReferenceDetail[];
  total: number;
  page: number;
  limit: number;
}

interface RefRow {
  id: number;
  name?: string;
  code?: string | null;
  status: RefStatus;
  in_use?: number | string;
  created_at: Date;
  updated_at: Date;
}

/** Raw SQL summing how many rows across all referencing tables point at this row. */
function inUseExpr(kind: ReferenceKind): Knex.Raw {
  const cfg = REFERENCE_KINDS[kind];
  // Table/column identifiers come from our own static config — never user input.
  const parts = cfg.references.map(
    (r) => `(SELECT COUNT(*) FROM \`${r.table}\` WHERE \`${r.table}\`.\`${r.column}\` = \`${cfg.table}\`.id)`,
  );
  return db.raw(parts.length ? `(${parts.join(' + ')})` : '0');
}

function toDetail(kind: ReferenceKind, row: RefRow): ReferenceDetail {
  const cfg = REFERENCE_KINDS[kind];
  const inUseCount = row.in_use !== undefined ? Number(row.in_use) : 0;
  return {
    id: row.id,
    name: cfg.hasCode ? (row.name as string) : (row.name as string),
    code: cfg.hasCode ? (row.code ?? null) : null,
    status: row.status,
    inUseCount,
    deletable: inUseCount === 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function countInUse(kind: ReferenceKind, id: number, runner: Knex | Knex.Transaction): Promise<number> {
  const cfg = REFERENCE_KINDS[kind];
  let total = 0;
  for (const r of cfg.references) {
    const res = (await runner(r.table).where(r.column, id).count({ c: '*' }).first()) as { c: number | string } | undefined;
    total += Number(res?.c ?? 0);
  }
  return total;
}

/** Uniqueness: units are unique by `code`, everything else by `name` — both
 *  case-insensitive on the normalized value (whitespace collapsed). */
async function assertUnique(
  kind: ReferenceKind,
  fields: { name: string; code?: string },
  excludeId: number | undefined,
  runner: Knex | Knex.Transaction,
): Promise<void> {
  const cfg = REFERENCE_KINDS[kind];
  const column = cfg.hasCode ? 'code' : 'name';
  const value = cfg.hasCode ? (fields.code as string) : fields.name;
  const q = runner(cfg.table).whereRaw(`LOWER(\`${column}\`) = LOWER(?)`, [value]);
  if (excludeId !== undefined) q.whereNot({ id: excludeId });
  if (await q.first()) {
    throw ApiError.conflict(
      cfg.hasCode ? `Bu kodli ${cfg.label.toLowerCase()} allaqachon mavjud` : `Bu nomdagi ${cfg.label.toLowerCase()} allaqachon mavjud`,
      'REFERENCE_DUPLICATE',
    );
  }
}

export async function listReference(kind: ReferenceKind, query: ListReferenceQuery): Promise<ListReferenceResult> {
  const cfg = REFERENCE_KINDS[kind];
  const orderCol = cfg.hasCode ? 'code' : 'name';

  const build = () => {
    const q = db(cfg.table);
    if (query.status) q.where('status', query.status);
    if (query.search) {
      const term = `%${query.search.replace(/[%_]/g, '\\$&')}%`;
      q.where((sub) => {
        sub.where('name', 'like', term);
        if (cfg.hasCode) sub.orWhere('code', 'like', term);
      });
    }
    return q;
  };

  const countRows = (await build().count({ count: '*' })) as unknown as [{ count: number | string }];
  const total = Number(countRows[0]?.count ?? 0);

  const rows = (await build()
    .select(`${cfg.table}.*`)
    .select({ in_use: inUseExpr(kind) })
    .orderBy(orderCol, 'asc')
    .orderBy('id', 'asc')
    .limit(query.limit)
    .offset((query.page - 1) * query.limit)) as RefRow[];

  return { items: rows.map((r) => toDetail(kind, r)), total, page: query.page, limit: query.limit };
}

export async function getReference(kind: ReferenceKind, id: number): Promise<ReferenceDetail> {
  const cfg = REFERENCE_KINDS[kind];
  const row = (await db(cfg.table)
    .select(`${cfg.table}.*`)
    .select({ in_use: inUseExpr(kind) })
    .where('id', id)
    .first()) as RefRow | undefined;
  if (!row) throw ApiError.notFound(`${cfg.label} topilmadi`);
  return toDetail(kind, row);
}

export async function createReference(
  kind: ReferenceKind,
  input: { name: string; code?: string },
  actor: AuthUser,
  meta: RequestMeta,
): Promise<ReferenceDetail> {
  const cfg = REFERENCE_KINDS[kind];
  const name = normalizeName(input.name);
  const code = input.code !== undefined ? normalizeName(input.code) : undefined;
  if (cfg.hasCode && !code) {
    throw ApiError.badRequest(`${cfg.label} uchun kod kiritilishi shart`, 'CODE_REQUIRED');
  }

  const id = await db.transaction(async (trx) => {
    await assertUnique(kind, { name, code }, undefined, trx);
    const insertRow: Record<string, unknown> = { name, status: 'ACTIVE' };
    if (cfg.hasCode) insertRow.code = code;
    const [newId] = await trx(cfg.table).insert(insertRow);
    await logAudit(
      {
        userId: actor.id,
        action: 'CATALOG_REFERENCE_CREATED',
        entityType: cfg.entityType,
        entityId: newId,
        newValue: cfg.hasCode ? { code, name } : { name },
        ...meta,
      },
      trx,
    );
    return newId as number;
  });

  return getReference(kind, id);
}

export async function updateReference(
  kind: ReferenceKind,
  id: number,
  input: { name?: string; code?: string },
  actor: AuthUser,
  meta: RequestMeta,
): Promise<ReferenceDetail> {
  const cfg = REFERENCE_KINDS[kind];

  await db.transaction(async (trx) => {
    const current = (await trx(cfg.table).where({ id }).forUpdate().first()) as RefRow | undefined;
    if (!current) throw ApiError.notFound(`${cfg.label} topilmadi`);

    const update: Record<string, unknown> = { updated_at: trx.fn.now() };
    const changes: Record<string, { old: unknown; new: unknown }> = {};

    if (input.name !== undefined) {
      const name = normalizeName(input.name);
      if (name !== current.name) {
        if (!cfg.hasCode) await assertUnique(kind, { name }, id, trx);
        update.name = name;
        changes.name = { old: current.name, new: name };
      }
    }
    if (cfg.hasCode && input.code !== undefined) {
      const code = normalizeName(input.code);
      if (code !== current.code) {
        await assertUnique(kind, { name: current.name as string, code }, id, trx);
        update.code = code;
        changes.code = { old: current.code, new: code };
      }
    }

    if (Object.keys(changes).length > 0) {
      await trx(cfg.table).where({ id }).update(update);
      await logAudit(
        { userId: actor.id, action: 'CATALOG_REFERENCE_UPDATED', entityType: cfg.entityType, entityId: id, newValue: changes, ...meta },
        trx,
      );
    }
  });

  return getReference(kind, id);
}

export async function setReferenceStatus(
  kind: ReferenceKind,
  id: number,
  status: RefStatus,
  actor: AuthUser,
  meta: RequestMeta,
): Promise<ReferenceDetail> {
  const cfg = REFERENCE_KINDS[kind];
  await db.transaction(async (trx) => {
    const current = (await trx(cfg.table).where({ id }).forUpdate().first()) as RefRow | undefined;
    if (!current) throw ApiError.notFound(`${cfg.label} topilmadi`);
    if (current.status === status) {
      throw ApiError.conflict(
        status === 'ACTIVE' ? `${cfg.label} allaqachon faol` : `${cfg.label} allaqachon arxivlangan`,
        'STATUS_UNCHANGED',
      );
    }
    await trx(cfg.table).where({ id }).update({ status, updated_at: trx.fn.now() });
    await logAudit(
      {
        userId: actor.id,
        action: status === 'ACTIVE' ? 'CATALOG_REFERENCE_REACTIVATED' : 'CATALOG_REFERENCE_ARCHIVED',
        entityType: cfg.entityType,
        entityId: id,
        oldValue: { status: current.status },
        newValue: { status },
        ...meta,
      },
      trx,
    );
  });
  return getReference(kind, id);
}

/**
 * Permanently delete an UNUSED reference row. Eligibility (no referencing product/
 * service) is re-checked INSIDE the transaction under a row lock, so a value that
 * became referenced between the list and the click cannot be deleted; the DB FK
 * RESTRICT is the final backstop and is never weakened. Referenced values must be
 * archived instead, and are reported with a stable REFERENCE_IN_USE conflict.
 */
export async function deleteReference(
  kind: ReferenceKind,
  id: number,
  actor: AuthUser,
  meta: RequestMeta,
): Promise<{ id: number }> {
  const cfg = REFERENCE_KINDS[kind];
  return db.transaction(async (trx) => {
    const current = (await trx(cfg.table).where({ id }).forUpdate().first()) as RefRow | undefined;
    if (!current) throw ApiError.notFound(`${cfg.label} topilmadi`);

    const inUse = await countInUse(kind, id, trx);
    if (inUse > 0) {
      throw ApiError.conflict(
        `Bu ${cfg.label.toLowerCase()} ${inUse} ta yozuvda ishlatilmoqda — o'chirib bo'lmaydi, uni arxivlang`,
        'REFERENCE_IN_USE',
      );
    }

    await trx(cfg.table).where({ id }).del();
    await logAudit(
      {
        userId: actor.id,
        action: 'CATALOG_REFERENCE_DELETED',
        entityType: cfg.entityType,
        entityId: id,
        oldValue: cfg.hasCode ? { code: current.code, name: current.name } : { name: current.name },
        ...meta,
      },
      trx,
    );
    return { id };
  });
}
