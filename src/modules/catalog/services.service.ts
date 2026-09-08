import type { Knex } from 'knex';
import { db } from '../../config/database';
import { ApiError } from '../../utils/errors';
import { logAudit } from '../audit/audit.service';
import { normalizeName } from './normalize';
import { assertCurrency, assertPriceMinor, DEFAULT_CURRENCY, readPriceMinor } from './money';
import type { AuthUser } from '../../types/auth';
import type { CreateServiceInput, ListServicesQuery, UpdateServiceInput } from './services.validators';

interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export type PriceBasis = 'NET' | 'GROSS' | 'UNKNOWN';

export interface ServiceDetail {
  id: number;
  code: string;
  name: string;
  categoryId: number;
  categoryName: string;
  durationMinutes: number | null;
  priceMinor: number | null;
  currency: string;
  priceBasis: PriceBasis;
  taxRateBp: number | null;
  priceInclusiveMinor: number | null;
  status: 'ACTIVE' | 'ARCHIVED';
  version: number;
  source: string;
  sourceRef: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ServiceRow {
  id: number;
  code: string;
  name: string;
  category_id: number;
  category_name: string;
  duration_minutes: number | null;
  price_minor: number | string | null;
  currency: string;
  price_basis: PriceBasis;
  tax_rate_bp: number | null;
  price_inclusive_minor: number | string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  version: number;
  source: string;
  source_ref: string | null;
  created_at: Date;
  updated_at: Date;
}

const SORT_FIELDS = {
  name: 'services.name',
  code: 'services.code',
  price: 'services.price_minor',
  createdAt: 'services.created_at',
  updatedAt: 'services.updated_at',
} as const;

const baseSelect = () =>
  db('services')
    .select('services.*', 'service_categories.name as category_name')
    .join('service_categories', 'service_categories.id', 'services.category_id');

function toDetail(row: ServiceRow): ServiceDetail {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    categoryId: row.category_id,
    categoryName: row.category_name,
    durationMinutes: row.duration_minutes,
    priceMinor: readPriceMinor(row.price_minor),
    currency: row.currency,
    priceBasis: row.price_basis,
    taxRateBp: row.tax_rate_bp,
    priceInclusiveMinor: readPriceMinor(row.price_inclusive_minor),
    status: row.status,
    version: Number(row.version),
    source: row.source,
    sourceRef: row.source_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ListServicesResult {
  items: ServiceDetail[];
  total: number;
  page: number;
  limit: number;
}

export async function listServices(query: ListServicesQuery): Promise<ListServicesResult> {
  const build = () => {
    const q = baseSelect();
    if (query.status) q.where('services.status', query.status);
    if (query.categoryId) q.where('services.category_id', query.categoryId);
    if (query.search) {
      const term = `%${query.search.replace(/[%_]/g, '\\$&')}%`;
      q.where((sub) => {
        sub.where('services.name', 'like', term).orWhere('services.code', 'like', term);
      });
    }
    return q;
  };

  const countRows = (await build().clearSelect().count({ count: 'services.id' })) as unknown as [
    { count: number | string },
  ];
  const total = Number(countRows[0]?.count ?? 0);

  const sortCol = SORT_FIELDS[query.sort ?? 'name'];
  const rows = (await build()
    .orderBy(sortCol, query.order ?? 'asc')
    .orderBy('services.id', 'asc')
    .limit(query.limit)
    .offset((query.page - 1) * query.limit)) as ServiceRow[];

  return { items: rows.map(toDetail), total, page: query.page, limit: query.limit };
}

export async function getService(id: number): Promise<ServiceDetail> {
  const row = (await baseSelect().where('services.id', id).first()) as ServiceRow | undefined;
  if (!row) throw ApiError.notFound('Xizmat topilmadi');
  return toDetail(row);
}

async function assertCategoryActive(trx: Knex.Transaction, id: number): Promise<void> {
  // Locked FOR UPDATE so a concurrent category delete can't race the service
  // insert into a raw FK error — see products.service assertRefActive.
  const row = (await trx('service_categories').where({ id }).forUpdate().first()) as { status: string } | undefined;
  if (!row) throw ApiError.badRequest('Kategoriya topilmadi', 'INVALID_CATEGORY');
  if (row.status !== 'ACTIVE') throw ApiError.badRequest('Kategoriya arxivlangan', 'INVALID_CATEGORY');
}

async function assertCodeAvailable(trx: Knex.Transaction, code: string, excludeId?: number): Promise<void> {
  const q = trx('services').whereRaw('LOWER(code) = LOWER(?)', [code]);
  if (excludeId !== undefined) q.whereNot({ id: excludeId });
  if (await q.first()) throw ApiError.conflict('Bu kodli xizmat allaqachon mavjud', 'SERVICE_CODE_TAKEN');
}

export async function createService(actor: AuthUser, input: CreateServiceInput, meta: RequestMeta): Promise<ServiceDetail> {
  assertPriceMinor(input.priceMinor);
  assertPriceMinor(input.priceInclusiveMinor);
  assertCurrency(input.currency);
  const code = normalizeName(input.code);
  const name = normalizeName(input.name);
  const currency = input.currency ?? DEFAULT_CURRENCY;
  const priceBasis: PriceBasis = input.priceBasis ?? 'UNKNOWN';

  const id = await db.transaction(async (trx) => {
    await assertCategoryActive(trx, input.categoryId);
    await assertCodeAvailable(trx, code);

    const [newId] = await trx('services').insert({
      code,
      name,
      category_id: input.categoryId,
      duration_minutes: input.durationMinutes ?? null,
      price_minor: input.priceMinor ?? null,
      currency,
      price_basis: priceBasis,
      tax_rate_bp: input.taxRateBp ?? null,
      price_inclusive_minor: input.priceInclusiveMinor ?? null,
      status: 'ACTIVE',
      version: 1,
      source: 'MANUAL',
      created_by: actor.id,
      updated_by: actor.id,
    });

    if (input.priceMinor != null) {
      await trx('catalog_price_history').insert({
        entity_type: 'service',
        entity_id: newId,
        old_price_minor: null,
        new_price_minor: input.priceMinor,
        currency,
        price_basis: priceBasis,
        changed_by: actor.id,
        reason: input.priceReason ?? null,
        source: 'MANUAL',
      });
    }

    await logAudit(
      {
        userId: actor.id,
        action: 'SERVICE_CREATED',
        entityType: 'service',
        entityId: newId,
        newValue: { code, name, categoryId: input.categoryId, priceMinor: input.priceMinor ?? null, currency, priceBasis },
        ...meta,
      },
      trx,
    );
    return newId as number;
  });

  return getService(id);
}

export async function updateService(
  actor: AuthUser,
  id: number,
  input: UpdateServiceInput,
  meta: RequestMeta,
): Promise<ServiceDetail> {
  assertPriceMinor(input.priceMinor);
  assertPriceMinor(input.priceInclusiveMinor);
  assertCurrency(input.currency);

  await db.transaction(async (trx) => {
    const current = (await trx('services').where({ id }).forUpdate().first()) as ServiceRow | undefined;
    if (!current) throw ApiError.notFound('Xizmat topilmadi');

    if (input.version !== current.version) {
      throw ApiError.conflict(
        "Xizmat boshqa foydalanuvchi tomonidan o'zgartirilgan — sahifani yangilab, qaytadan urinib ko'ring",
        'STALE_WRITE',
      );
    }

    if (input.categoryId !== undefined && input.categoryId !== current.category_id)
      await assertCategoryActive(trx, input.categoryId);
    let nextCode = current.code;
    if (input.code !== undefined) nextCode = normalizeName(input.code);
    if (nextCode !== current.code) await assertCodeAvailable(trx, nextCode, id);

    const update: Record<string, unknown> = { updated_at: trx.fn.now(), updated_by: actor.id, version: current.version + 1 };
    const changes: Record<string, { old: unknown; new: unknown }> = {};
    const setField = (col: string, key: string, next: unknown, old: unknown) => {
      if (next !== old) {
        update[col] = next;
        changes[key] = { old, new: next };
      }
    };
    if (input.code !== undefined) setField('code', 'code', nextCode, current.code);
    if (input.name !== undefined) setField('name', 'name', normalizeName(input.name), current.name);
    if (input.categoryId !== undefined) setField('category_id', 'categoryId', input.categoryId, current.category_id);
    if (input.durationMinutes !== undefined) setField('duration_minutes', 'durationMinutes', input.durationMinutes, current.duration_minutes);
    if (input.taxRateBp !== undefined) setField('tax_rate_bp', 'taxRateBp', input.taxRateBp, current.tax_rate_bp);
    if (input.priceInclusiveMinor !== undefined)
      setField('price_inclusive_minor', 'priceInclusiveMinor', input.priceInclusiveMinor, readPriceMinor(current.price_inclusive_minor));

    const nextBasis: PriceBasis = input.priceBasis ?? current.price_basis;
    if (input.priceBasis !== undefined) setField('price_basis', 'priceBasis', nextBasis, current.price_basis);

    const currentPrice = readPriceMinor(current.price_minor);
    const nextCurrency = input.currency ?? current.currency;
    const priceChanged =
      (input.priceMinor !== undefined && input.priceMinor !== currentPrice) ||
      (input.currency !== undefined && input.currency !== current.currency);
    if (priceChanged) {
      const nextPrice = input.priceMinor !== undefined ? input.priceMinor : currentPrice;
      update.price_minor = nextPrice;
      update.currency = nextCurrency;
      await trx('catalog_price_history').insert({
        entity_type: 'service',
        entity_id: id,
        old_price_minor: currentPrice,
        new_price_minor: nextPrice,
        currency: nextCurrency,
        price_basis: nextBasis,
        changed_by: actor.id,
        reason: input.priceReason ?? null,
        source: 'MANUAL',
      });
    }

    await trx('services').where({ id }).update(update);

    if (priceChanged) {
      await logAudit(
        {
          userId: actor.id,
          action: 'SERVICE_PRICE_CHANGED',
          entityType: 'service',
          entityId: id,
          oldValue: { priceMinor: currentPrice, currency: current.currency },
          newValue: { priceMinor: update.price_minor, currency: nextCurrency, priceBasis: nextBasis, reason: input.priceReason ?? null },
          ...meta,
        },
        trx,
      );
    }
    if (Object.keys(changes).length > 0) {
      await logAudit(
        { userId: actor.id, action: 'SERVICE_UPDATED', entityType: 'service', entityId: id, newValue: changes, ...meta },
        trx,
      );
    }
  });

  return getService(id);
}

export async function setServiceStatus(
  actor: AuthUser,
  id: number,
  status: 'ACTIVE' | 'ARCHIVED',
  meta: RequestMeta,
): Promise<ServiceDetail> {
  await db.transaction(async (trx) => {
    const current = (await trx('services').where({ id }).forUpdate().first()) as { status: string; version: number } | undefined;
    if (!current) throw ApiError.notFound('Xizmat topilmadi');
    if (current.status === status) {
      throw ApiError.conflict(status === 'ACTIVE' ? 'Xizmat allaqachon faol' : 'Xizmat allaqachon arxivlangan', 'STATUS_UNCHANGED');
    }
    await trx('services').where({ id }).update({ status, version: current.version + 1, updated_by: actor.id, updated_at: trx.fn.now() });
    await logAudit(
      {
        userId: actor.id,
        action: status === 'ACTIVE' ? 'SERVICE_REACTIVATED' : 'SERVICE_ARCHIVED',
        entityType: 'service',
        entityId: id,
        oldValue: { status: current.status },
        newValue: { status },
        ...meta,
      },
      trx,
    );
  });
  return getService(id);
}

export async function deleteService(actor: AuthUser, id: number, meta: RequestMeta): Promise<{ id: number }> {
  return db.transaction(async (trx) => {
    const current = (await trx('services').where({ id }).forUpdate().first()) as { code: string; name: string } | undefined;
    if (!current) throw ApiError.notFound('Xizmat topilmadi');
    await trx('catalog_price_history').where({ entity_type: 'service', entity_id: id }).del();
    await trx('services').where({ id }).del();
    await logAudit(
      {
        userId: actor.id,
        action: 'SERVICE_DELETED',
        entityType: 'service',
        entityId: id,
        oldValue: { code: current.code, name: current.name },
        ...meta,
      },
      trx,
    );
    return { id };
  });
}
