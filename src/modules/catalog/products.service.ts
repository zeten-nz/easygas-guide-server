import type { Knex } from 'knex';
import { db } from '../../config/database';
import { ApiError } from '../../utils/errors';
import { logAudit } from '../audit/audit.service';
import { normalizeName } from './normalize';
import { assertCurrency, assertPriceMinor, DEFAULT_CURRENCY, readPriceMinor } from './money';
import type { AuthUser } from '../../types/auth';
import type { CreateProductInput, ListProductsQuery, UpdateProductInput } from './products.validators';

interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export interface ProductDetail {
  id: number;
  code: string;
  name: string;
  companyId: number;
  companyName: string;
  brandId: number | null;
  brandName: string | null;
  categoryId: number;
  categoryName: string;
  unitId: number | null;
  unitCode: string | null;
  unitName: string | null;
  priceMinor: number | null;
  currency: string;
  status: 'ACTIVE' | 'ARCHIVED';
  version: number;
  source: string;
  sourceRef: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ProductRow {
  id: number;
  code: string;
  name: string;
  company_id: number;
  company_name: string;
  brand_id: number | null;
  brand_name: string | null;
  category_id: number;
  category_name: string;
  unit_id: number | null;
  unit_code: string | null;
  unit_name: string | null;
  price_minor: number | string | null;
  currency: string;
  status: 'ACTIVE' | 'ARCHIVED';
  version: number;
  source: string;
  source_ref: string | null;
  created_at: Date;
  updated_at: Date;
}

const SORT_FIELDS = {
  name: 'products.name',
  code: 'products.code',
  price: 'products.price_minor',
  createdAt: 'products.created_at',
  updatedAt: 'products.updated_at',
} as const;
export type ProductSortField = keyof typeof SORT_FIELDS;

const baseSelect = () =>
  db('products')
    .select(
      'products.*',
      'catalog_companies.name as company_name',
      'catalog_brands.name as brand_name',
      'product_categories.name as category_name',
      'catalog_units.code as unit_code',
      'catalog_units.name as unit_name',
    )
    .join('catalog_companies', 'catalog_companies.id', 'products.company_id')
    .leftJoin('catalog_brands', 'catalog_brands.id', 'products.brand_id')
    .join('product_categories', 'product_categories.id', 'products.category_id')
    .leftJoin('catalog_units', 'catalog_units.id', 'products.unit_id');

function toDetail(row: ProductRow): ProductDetail {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    companyId: row.company_id,
    companyName: row.company_name,
    brandId: row.brand_id,
    brandName: row.brand_name,
    categoryId: row.category_id,
    categoryName: row.category_name,
    unitId: row.unit_id,
    unitCode: row.unit_code,
    unitName: row.unit_name,
    priceMinor: readPriceMinor(row.price_minor),
    currency: row.currency,
    status: row.status,
    version: Number(row.version),
    source: row.source,
    sourceRef: row.source_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ListProductsResult {
  items: ProductDetail[];
  total: number;
  page: number;
  limit: number;
}

export async function listProducts(query: ListProductsQuery): Promise<ListProductsResult> {
  const build = () => {
    const q = baseSelect();
    if (query.status) q.where('products.status', query.status);
    if (query.companyId) q.where('products.company_id', query.companyId);
    if (query.brandId) q.where('products.brand_id', query.brandId);
    if (query.categoryId) q.where('products.category_id', query.categoryId);
    if (query.search) {
      const term = `%${query.search.replace(/[%_]/g, '\\$&')}%`;
      q.where((sub) => {
        sub.where('products.name', 'like', term).orWhere('products.code', 'like', term);
      });
    }
    return q;
  };

  const countRows = (await build().clearSelect().count({ count: 'products.id' })) as unknown as [
    { count: number | string },
  ];
  const total = Number(countRows[0]?.count ?? 0);

  const sortCol = SORT_FIELDS[query.sort ?? 'name'];
  const rows = (await build()
    .orderBy(sortCol, query.order ?? 'asc')
    .orderBy('products.id', 'asc')
    .limit(query.limit)
    .offset((query.page - 1) * query.limit)) as ProductRow[];

  return { items: rows.map(toDetail), total, page: query.page, limit: query.limit };
}

export async function getProduct(id: number): Promise<ProductDetail> {
  const row = (await baseSelect().where('products.id', id).first()) as ProductRow | undefined;
  if (!row) throw ApiError.notFound('Mahsulot topilmadi');
  return toDetail(row);
}

/**
 * A reference row must exist AND be ACTIVE to be freshly assigned to a product.
 * The row is locked FOR UPDATE so a concurrent reference DELETE cannot slip in
 * between this check and the product insert: the delete either blocks until we
 * commit (then it sees the new product and refuses with REFERENCE_IN_USE) or it
 * committed first (then this locking read returns nothing → INVALID_*). This is
 * what turns the would-be raw FK error into a clean business outcome.
 */
async function assertRefActive(
  trx: Knex.Transaction,
  table: string,
  id: number,
  code: string,
  label: string,
): Promise<void> {
  const row = (await trx(table).where({ id }).forUpdate().first()) as { status: string } | undefined;
  if (!row) throw ApiError.badRequest(`${label} topilmadi`, code);
  if (row.status !== 'ACTIVE') throw ApiError.badRequest(`${label} arxivlangan`, code);
}

async function assertCodeAvailable(
  trx: Knex.Transaction,
  companyId: number,
  code: string,
  excludeId?: number,
): Promise<void> {
  const q = trx('products').where({ company_id: companyId }).whereRaw('LOWER(code) = LOWER(?)', [code]);
  if (excludeId !== undefined) q.whereNot({ id: excludeId });
  if (await q.first()) {
    throw ApiError.conflict('Bu kompaniyada shu kodli mahsulot allaqachon mavjud', 'PRODUCT_CODE_TAKEN');
  }
}

export async function createProduct(actor: AuthUser, input: CreateProductInput, meta: RequestMeta): Promise<ProductDetail> {
  assertPriceMinor(input.priceMinor);
  assertCurrency(input.currency);
  const code = normalizeName(input.code);
  const name = normalizeName(input.name);
  const currency = input.currency ?? DEFAULT_CURRENCY;

  const id = await db.transaction(async (trx) => {
    await assertRefActive(trx, 'catalog_companies', input.companyId, 'INVALID_COMPANY', 'Kompaniya');
    await assertRefActive(trx, 'product_categories', input.categoryId, 'INVALID_CATEGORY', 'Kategoriya');
    if (input.brandId != null) await assertRefActive(trx, 'catalog_brands', input.brandId, 'INVALID_BRAND', 'Brend');
    if (input.unitId != null) await assertRefActive(trx, 'catalog_units', input.unitId, 'INVALID_UNIT', "O'lchov birligi");
    await assertCodeAvailable(trx, input.companyId, code);

    const [newId] = await trx('products').insert({
      code,
      name,
      company_id: input.companyId,
      brand_id: input.brandId ?? null,
      category_id: input.categoryId,
      unit_id: input.unitId ?? null,
      price_minor: input.priceMinor ?? null,
      currency,
      status: 'ACTIVE',
      version: 1,
      source: 'MANUAL',
      created_by: actor.id,
      updated_by: actor.id,
    });

    // Record the opening price as history when a price is set at creation.
    if (input.priceMinor != null) {
      await trx('catalog_price_history').insert({
        entity_type: 'product',
        entity_id: newId,
        old_price_minor: null,
        new_price_minor: input.priceMinor,
        currency,
        changed_by: actor.id,
        reason: input.priceReason ?? null,
        source: 'MANUAL',
      });
    }

    await logAudit(
      {
        userId: actor.id,
        action: 'PRODUCT_CREATED',
        entityType: 'product',
        entityId: newId,
        newValue: { code, name, companyId: input.companyId, categoryId: input.categoryId, priceMinor: input.priceMinor ?? null, currency },
        ...meta,
      },
      trx,
    );
    return newId as number;
  });

  return getProduct(id);
}

export async function updateProduct(
  actor: AuthUser,
  id: number,
  input: UpdateProductInput,
  meta: RequestMeta,
): Promise<ProductDetail> {
  assertPriceMinor(input.priceMinor);
  assertCurrency(input.currency);

  await db.transaction(async (trx) => {
    const current = (await trx('products').where({ id }).forUpdate().first()) as
      | (ProductRow & { price_minor: number | string | null })
      | undefined;
    if (!current) throw ApiError.notFound('Mahsulot topilmadi');

    // Optimistic concurrency: the caller must submit the version they edited.
    if (input.version !== current.version) {
      throw ApiError.conflict(
        "Mahsulot boshqa foydalanuvchi tomonidan o'zgartirilgan — sahifani yangilab, qaytadan urinib ko'ring",
        'STALE_WRITE',
      );
    }

    // Validate any newly-assigned references.
    if (input.categoryId !== undefined && input.categoryId !== current.category_id)
      await assertRefActive(trx, 'product_categories', input.categoryId, 'INVALID_CATEGORY', 'Kategoriya');
    if (input.brandId !== undefined && input.brandId !== null && input.brandId !== current.brand_id)
      await assertRefActive(trx, 'catalog_brands', input.brandId, 'INVALID_BRAND', 'Brend');
    if (input.unitId !== undefined && input.unitId !== null && input.unitId !== current.unit_id)
      await assertRefActive(trx, 'catalog_units', input.unitId, 'INVALID_UNIT', "O'lchov birligi");

    const nextCompany = input.companyId ?? current.company_id;
    let nextCode = current.code;
    if (input.code !== undefined) nextCode = normalizeName(input.code);
    if (input.companyId !== undefined && input.companyId !== current.company_id)
      await assertRefActive(trx, 'catalog_companies', input.companyId, 'INVALID_COMPANY', 'Kompaniya');
    if (nextCode !== current.code || nextCompany !== current.company_id)
      await assertCodeAvailable(trx, nextCompany, nextCode, id);

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
    if (input.companyId !== undefined) setField('company_id', 'companyId', input.companyId, current.company_id);
    if (input.brandId !== undefined) setField('brand_id', 'brandId', input.brandId, current.brand_id);
    if (input.categoryId !== undefined) setField('category_id', 'categoryId', input.categoryId, current.category_id);
    if (input.unitId !== undefined) setField('unit_id', 'unitId', input.unitId, current.unit_id);

    // Price change → history row + dedicated audit, all inside this transaction.
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
        entity_type: 'product',
        entity_id: id,
        old_price_minor: currentPrice,
        new_price_minor: nextPrice,
        currency: nextCurrency,
        changed_by: actor.id,
        reason: input.priceReason ?? null,
        source: 'MANUAL',
      });
    }

    // Always bump version/updated_by even if only the price changed.
    await trx('products').where({ id }).update(update);

    if (priceChanged) {
      await logAudit(
        {
          userId: actor.id,
          action: 'PRODUCT_PRICE_CHANGED',
          entityType: 'product',
          entityId: id,
          oldValue: { priceMinor: currentPrice, currency: current.currency },
          newValue: { priceMinor: update.price_minor, currency: nextCurrency, reason: input.priceReason ?? null },
          ...meta,
        },
        trx,
      );
    }
    if (Object.keys(changes).length > 0) {
      await logAudit(
        { userId: actor.id, action: 'PRODUCT_UPDATED', entityType: 'product', entityId: id, newValue: changes, ...meta },
        trx,
      );
    }
  });

  return getProduct(id);
}

export async function setProductStatus(
  actor: AuthUser,
  id: number,
  status: 'ACTIVE' | 'ARCHIVED',
  meta: RequestMeta,
): Promise<ProductDetail> {
  await db.transaction(async (trx) => {
    const current = (await trx('products').where({ id }).forUpdate().first()) as { status: string; version: number } | undefined;
    if (!current) throw ApiError.notFound('Mahsulot topilmadi');
    if (current.status === status) {
      throw ApiError.conflict(status === 'ACTIVE' ? 'Mahsulot allaqachon faol' : 'Mahsulot allaqachon arxivlangan', 'STATUS_UNCHANGED');
    }
    await trx('products').where({ id }).update({ status, version: current.version + 1, updated_by: actor.id, updated_at: trx.fn.now() });
    await logAudit(
      {
        userId: actor.id,
        action: status === 'ACTIVE' ? 'PRODUCT_REACTIVATED' : 'PRODUCT_ARCHIVED',
        entityType: 'product',
        entityId: id,
        oldValue: { status: current.status },
        newValue: { status },
        ...meta,
      },
      trx,
    );
  });
  return getProduct(id);
}

/**
 * Permanently delete a product. Nothing in the business schema references a
 * product (job billing is out of scope, so no job row points at it), so a
 * product is always eligible; its price-history rows are removed with it (the
 * immutable audit chain retains the PRODUCT_* evidence). No historical job is
 * touched — catalogue prices are never attached retroactively to jobs.
 */
export async function deleteProduct(actor: AuthUser, id: number, meta: RequestMeta): Promise<{ id: number }> {
  return db.transaction(async (trx) => {
    const current = (await trx('products').where({ id }).forUpdate().first()) as
      | { code: string; name: string }
      | undefined;
    if (!current) throw ApiError.notFound('Mahsulot topilmadi');

    await trx('catalog_price_history').where({ entity_type: 'product', entity_id: id }).del();
    await trx('products').where({ id }).del();

    await logAudit(
      {
        userId: actor.id,
        action: 'PRODUCT_DELETED',
        entityType: 'product',
        entityId: id,
        oldValue: { code: current.code, name: current.name },
        ...meta,
      },
      trx,
    );
    return { id };
  });
}

export interface PriceHistoryEntry {
  id: number;
  oldPriceMinor: number | null;
  newPriceMinor: number | null;
  currency: string;
  changedById: number | null;
  changedByName: string | null;
  reason: string | null;
  source: string;
  createdAt: Date;
}

export async function getPriceHistory(entityType: 'product' | 'service', entityId: number): Promise<PriceHistoryEntry[]> {
  const rows = (await db('catalog_price_history')
    .select(
      'catalog_price_history.*',
      db.raw("CONCAT(users.first_name, ' ', users.last_name) as changed_by_name"),
    )
    .leftJoin('users', 'users.id', 'catalog_price_history.changed_by')
    .where({ entity_type: entityType, entity_id: entityId })
    .orderBy('catalog_price_history.created_at', 'desc')
    .orderBy('catalog_price_history.id', 'desc')) as {
    id: number;
    old_price_minor: number | string | null;
    new_price_minor: number | string | null;
    currency: string;
    changed_by: number | null;
    changed_by_name: string | null;
    reason: string | null;
    source: string;
    created_at: Date;
  }[];
  return rows.map((r) => ({
    id: r.id,
    oldPriceMinor: readPriceMinor(r.old_price_minor),
    newPriceMinor: readPriceMinor(r.new_price_minor),
    currency: r.currency,
    changedById: r.changed_by,
    changedByName: r.changed_by_name,
    reason: r.reason,
    source: r.source,
    createdAt: r.created_at,
  }));
}
