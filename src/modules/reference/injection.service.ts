import { db } from '../../config/database';
import { ApiError } from '../../utils/errors';
import { logAudit } from '../audit/audit.service';
import { normalizeName } from '../catalog/normalize';
import type { AuthUser } from '../../types/auth';
import type { CreateInjectionInput, ListInjectionQuery, UpdateInjectionInput } from './injection.validators';

interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

/**
 * Injection reference — modelled to keep INDEPENDENT concepts independent:
 *   • `technology` is the injection technology (port/multipoint vs direct);
 *   • `forcedInduction` is a SEPARATE attribute — Turbo/supercharged is never an
 *     injection technology;
 *   • `designation` is the manufacturer label (MPI, GDI, FSI…). FSI, for example,
 *     is a manufacturer designation associated with DIRECT injection.
 * Every field supports UNKNOWN. Compatibility is never inferred from the label.
 */
export const INJECTION_TECHNOLOGIES = ['PORT_MULTIPOINT', 'DIRECT', 'UNKNOWN'] as const;
export const FORCED_INDUCTION = ['NONE', 'TURBO', 'SUPERCHARGED', 'UNKNOWN'] as const;
export type InjectionTechnology = (typeof INJECTION_TECHNOLOGIES)[number];
export type ForcedInduction = (typeof FORCED_INDUCTION)[number];

export interface InjectionDetail {
  id: number;
  designation: string;
  technology: InjectionTechnology;
  forcedInduction: ForcedInduction;
  description: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  createdAt: Date;
  updatedAt: Date;
}

interface InjectionRow {
  id: number;
  designation: string;
  technology: InjectionTechnology;
  forced_induction: ForcedInduction;
  description: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  created_at: Date;
  updated_at: Date;
}

function toDetail(row: InjectionRow): InjectionDetail {
  return {
    id: row.id,
    designation: row.designation,
    technology: row.technology,
    forcedInduction: row.forced_induction,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function assertDesignationAvailable(designation: string, excludeId?: number): Promise<void> {
  const q = db('injection_reference').whereRaw('LOWER(designation) = LOWER(?)', [designation]);
  if (excludeId !== undefined) q.whereNot({ id: excludeId });
  if (await q.first()) throw ApiError.conflict('Bu belgidagi yozuv allaqachon mavjud', 'REFERENCE_DUPLICATE');
}

export interface ListInjectionResult {
  items: InjectionDetail[];
  total: number;
  page: number;
  limit: number;
}

export async function listInjection(query: ListInjectionQuery): Promise<ListInjectionResult> {
  const build = () => {
    const q = db('injection_reference');
    if (query.status) q.where('status', query.status);
    if (query.technology) q.where('technology', query.technology);
    if (query.search) {
      const term = `%${query.search.replace(/[%_]/g, '\\$&')}%`;
      q.where((sub) => sub.where('designation', 'like', term).orWhere('description', 'like', term));
    }
    return q;
  };

  const countRows = (await build().count({ count: '*' })) as unknown as [{ count: number | string }];
  const total = Number(countRows[0]?.count ?? 0);

  const rows = (await build()
    .select('*')
    .orderBy('designation', 'asc')
    .orderBy('id', 'asc')
    .limit(query.limit)
    .offset((query.page - 1) * query.limit)) as InjectionRow[];

  return { items: rows.map(toDetail), total, page: query.page, limit: query.limit };
}

export async function getInjection(id: number): Promise<InjectionDetail> {
  const row = (await db('injection_reference').where({ id }).first()) as InjectionRow | undefined;
  if (!row) throw ApiError.notFound('Yozuv topilmadi');
  return toDetail(row);
}

export async function createInjection(actor: AuthUser, input: CreateInjectionInput, meta: RequestMeta): Promise<InjectionDetail> {
  const designation = normalizeName(input.designation);
  const id = await db.transaction(async (trx) => {
    await assertDesignationAvailable(designation);
    const [newId] = await trx('injection_reference').insert({
      designation,
      technology: input.technology ?? 'UNKNOWN',
      forced_induction: input.forcedInduction ?? 'UNKNOWN',
      description: input.description ?? null,
      status: 'ACTIVE',
    });
    await logAudit(
      {
        userId: actor.id,
        action: 'CATALOG_REFERENCE_CREATED',
        entityType: 'injection_reference',
        entityId: newId,
        newValue: { designation, technology: input.technology ?? 'UNKNOWN', forcedInduction: input.forcedInduction ?? 'UNKNOWN' },
        ...meta,
      },
      trx,
    );
    return newId as number;
  });
  return getInjection(id);
}

export async function updateInjection(
  actor: AuthUser,
  id: number,
  input: UpdateInjectionInput,
  meta: RequestMeta,
): Promise<InjectionDetail> {
  await db.transaction(async (trx) => {
    const current = (await trx('injection_reference').where({ id }).forUpdate().first()) as InjectionRow | undefined;
    if (!current) throw ApiError.notFound('Yozuv topilmadi');

    const update: Record<string, unknown> = { updated_at: trx.fn.now() };
    const changes: Record<string, { old: unknown; new: unknown }> = {};
    if (input.designation !== undefined) {
      const designation = normalizeName(input.designation);
      if (designation !== current.designation) {
        await assertDesignationAvailable(designation, id);
        update.designation = designation;
        changes.designation = { old: current.designation, new: designation };
      }
    }
    if (input.technology !== undefined && input.technology !== current.technology) {
      update.technology = input.technology;
      changes.technology = { old: current.technology, new: input.technology };
    }
    if (input.forcedInduction !== undefined && input.forcedInduction !== current.forced_induction) {
      update.forced_induction = input.forcedInduction;
      changes.forcedInduction = { old: current.forced_induction, new: input.forcedInduction };
    }
    if (input.description !== undefined && input.description !== current.description) {
      update.description = input.description;
      changes.description = { old: current.description, new: input.description };
    }

    if (Object.keys(changes).length > 0) {
      await trx('injection_reference').where({ id }).update(update);
      await logAudit(
        { userId: actor.id, action: 'CATALOG_REFERENCE_UPDATED', entityType: 'injection_reference', entityId: id, newValue: changes, ...meta },
        trx,
      );
    }
  });
  return getInjection(id);
}

export async function setInjectionStatus(
  actor: AuthUser,
  id: number,
  status: 'ACTIVE' | 'ARCHIVED',
  meta: RequestMeta,
): Promise<InjectionDetail> {
  await db.transaction(async (trx) => {
    const current = (await trx('injection_reference').where({ id }).forUpdate().first()) as { status: string } | undefined;
    if (!current) throw ApiError.notFound('Yozuv topilmadi');
    if (current.status === status) {
      throw ApiError.conflict(status === 'ACTIVE' ? 'Yozuv allaqachon faol' : 'Yozuv allaqachon arxivlangan', 'STATUS_UNCHANGED');
    }
    await trx('injection_reference').where({ id }).update({ status, updated_at: trx.fn.now() });
    await logAudit(
      {
        userId: actor.id,
        action: status === 'ACTIVE' ? 'CATALOG_REFERENCE_REACTIVATED' : 'CATALOG_REFERENCE_ARCHIVED',
        entityType: 'injection_reference',
        entityId: id,
        oldValue: { status: current.status },
        newValue: { status },
        ...meta,
      },
      trx,
    );
  });
  return getInjection(id);
}

export async function deleteInjection(actor: AuthUser, id: number, meta: RequestMeta): Promise<{ id: number }> {
  return db.transaction(async (trx) => {
    const current = (await trx('injection_reference').where({ id }).forUpdate().first()) as { designation: string } | undefined;
    if (!current) throw ApiError.notFound('Yozuv topilmadi');
    await trx('injection_reference').where({ id }).del();
    await logAudit(
      {
        userId: actor.id,
        action: 'CATALOG_REFERENCE_DELETED',
        entityType: 'injection_reference',
        entityId: id,
        oldValue: { designation: current.designation },
        ...meta,
      },
      trx,
    );
    return { id };
  });
}
