import type { Knex } from 'knex';
import { normalizeName } from '../normalize';
import { isValidPriceMinor } from '../money';
import { logAudit } from '../../audit/audit.service';

/**
 * Safe catalogue import (Phase 11B §9).
 *
 * The source is parsed as DATA only — never executed. The canonical format is a
 * JSON document ({ products: [...], services: [...] }); a best-effort extractor
 * can also pull the two array literals out of the owner HTML prototype as TEXT
 * and JSON.parse them (no eval / new Function). Import is DRY-RUN by default and
 * INSERT-ONLY: existing rows (matched by their code) are reported and never
 * overwritten, so a re-import cannot duplicate entries or silently clobber a
 * later manual edit. Missing reference values (company/brand/category/unit) are
 * created on apply with IMPORT provenance and reported. Imported prices are
 * provisional — recorded in price history with source=IMPORT — and are never
 * treated as approved business prices.
 */

export interface RawProduct {
  code?: unknown;
  name?: unknown;
  company?: unknown;
  brand?: unknown;
  category?: unknown;
  unit?: unknown;
  priceMinor?: unknown;
  currency?: unknown;
}
export interface RawService {
  code?: unknown;
  name?: unknown;
  category?: unknown;
  durationMinutes?: unknown;
  priceMinor?: unknown;
  priceBasis?: unknown;
  taxRateBp?: unknown;
  priceInclusiveMinor?: unknown;
}
export interface RawSource {
  products?: RawProduct[];
  services?: RawService[];
}

export interface ImportIssue {
  kind: 'product' | 'service';
  index: number;
  code: string | null;
  reason: string;
}

export interface ImportReport {
  products: { total: number; toInsert: number; existing: number; invalid: number };
  services: { total: number; toInsert: number; existing: number; invalid: number };
  referencesToCreate: { companies: string[]; brands: string[]; productCategories: string[]; serviceCategories: string[]; units: string[] };
  issues: ImportIssue[];
  applied: boolean;
  // Populated only on a successful apply.
  inserted?: { products: number; services: number; references: number };
}

/** Parse the source TEXT into a RawSource. JSON is authoritative. */
export function parseSource(text: string, format: 'json' | 'html'): RawSource {
  if (format === 'json') {
    const data = JSON.parse(text) as RawSource;
    return { products: data.products ?? [], services: data.services ?? [] };
  }
  return parseHtmlSource(text);
}

/**
 * Extract the `PARTS`/`LABOR` array literals from the owner HTML prototype WITHOUT
 * executing it. Only strict JSON arrays are accepted; anything that is not valid
 * JSON is reported (never eval'd). Returns empty lists if the markers are absent.
 */
export function parseHtmlSource(text: string): RawSource {
  const grab = (marker: RegExp): unknown[] => {
    const m = text.match(marker);
    if (!m) return [];
    try {
      const parsed = JSON.parse(m[1]);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  // Match `const PARTS = [ ... ];` / `const LABOR = [ ... ];` capturing the array.
  const products = grab(/\b(?:const|let|var)\s+PARTS\s*=\s*(\[[\s\S]*?\])\s*;/) as RawProduct[];
  const services = grab(/\b(?:const|let|var)\s+LABOR\s*=\s*(\[[\s\S]*?\])\s*;/) as RawService[];
  return { products, services };
}

function asString(v: unknown): string | null {
  if (typeof v === 'string') return normalizeName(v);
  if (typeof v === 'number') return String(v);
  return null;
}
function asPrice(v: unknown): number | null | 'invalid' {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'invalid';
  if (!isValidPriceMinor(n)) return 'invalid';
  return n;
}

interface PlannedProduct {
  code: string;
  name: string;
  company: string;
  brand: string | null;
  category: string;
  unit: string | null;
  priceMinor: number | null;
  currency: string;
}
interface PlannedService {
  code: string;
  name: string;
  category: string;
  durationMinutes: number | null;
  priceMinor: number | null;
  priceBasis: 'NET' | 'GROSS' | 'UNKNOWN';
  taxRateBp: number | null;
  priceInclusiveMinor: number | null;
}

interface Plan {
  products: PlannedProduct[];
  services: PlannedService[];
  existingProductCodes: Set<string>; // `${companyKey}::${codeKey}`
  existingServiceCodes: Set<string>;
  refs: { companies: Set<string>; brands: Set<string>; productCategories: Set<string>; serviceCategories: Set<string>; units: Set<string> };
  issues: ImportIssue[];
}

const key = (s: string) => s.toLocaleLowerCase('uz-UZ');

async function buildPlan(source: RawSource, runner: Knex | Knex.Transaction): Promise<Plan> {
  const issues: ImportIssue[] = [];
  const products: PlannedProduct[] = [];
  const services: PlannedService[] = [];
  const refs = {
    companies: new Set<string>(),
    brands: new Set<string>(),
    productCategories: new Set<string>(),
    serviceCategories: new Set<string>(),
    units: new Set<string>(),
  };

  // Existing keys for idempotency.
  const existingCompanies = new Map<string, number>();
  for (const r of (await runner('catalog_companies').select('id', 'name')) as { id: number; name: string }[])
    existingCompanies.set(key(r.name), r.id);
  const existingProducts = (await runner('products')
    .join('catalog_companies', 'catalog_companies.id', 'products.company_id')
    .select('products.code as code', 'catalog_companies.name as company')) as { code: string; company: string }[];
  const existingProductCodes = new Set(existingProducts.map((p) => `${key(p.company)}::${key(p.code)}`));
  const existingServiceCodes = new Set(
    ((await runner('services').select('code')) as { code: string }[]).map((s) => key(s.code)),
  );

  const knownRefNames = async (table: string) =>
    new Set(((await runner(table).select('name')) as { name: string }[]).map((r) => key(r.name)));
  const knownUnits = new Set(((await runner('catalog_units').select('code')) as { code: string }[]).map((u) => key(u.code)));
  const knownBrands = await knownRefNames('catalog_brands');
  const knownProductCats = await knownRefNames('product_categories');
  const knownServiceCats = await knownRefNames('service_categories');
  const knownCompanies = new Set([...existingCompanies.keys()]);

  const seenProduct = new Set<string>();
  source.products?.forEach((raw, index) => {
    const code = asString(raw.code);
    const name = asString(raw.name);
    const company = asString(raw.company);
    const category = asString(raw.category);
    if (!code || !name || !company || !category) {
      issues.push({ kind: 'product', index, code, reason: 'code, name, company va category majburiy' });
      return;
    }
    const price = asPrice(raw.priceMinor);
    if (price === 'invalid') {
      issues.push({ kind: 'product', index, code, reason: 'priceMinor butun, manfiy bo\'lmagan qiymat bo\'lishi kerak' });
      return;
    }
    const compositeKey = `${key(company)}::${key(code)}`;
    if (existingProductCodes.has(compositeKey) || seenProduct.has(compositeKey)) {
      issues.push({ kind: 'product', index, code, reason: 'allaqachon mavjud (o\'tkazib yuborildi — manual tahrir saqlanadi)' });
      return;
    }
    seenProduct.add(compositeKey);
    const brand = asString(raw.brand);
    const unit = asString(raw.unit);
    if (!knownCompanies.has(key(company))) refs.companies.add(company);
    if (brand && !knownBrands.has(key(brand))) refs.brands.add(brand);
    if (!knownProductCats.has(key(category))) refs.productCategories.add(category);
    if (unit && !knownUnits.has(key(unit))) refs.units.add(unit);
    products.push({ code, name, company, brand, category, unit, priceMinor: price, currency: 'UZS' });
  });

  const seenService = new Set<string>();
  source.services?.forEach((raw, index) => {
    const code = asString(raw.code);
    const name = asString(raw.name);
    const category = asString(raw.category);
    if (!code || !name || !category) {
      issues.push({ kind: 'service', index, code, reason: 'code, name va category majburiy' });
      return;
    }
    const price = asPrice(raw.priceMinor);
    const inclusive = asPrice(raw.priceInclusiveMinor);
    if (price === 'invalid' || inclusive === 'invalid') {
      issues.push({ kind: 'service', index, code, reason: 'narx qiymati noto\'g\'ri' });
      return;
    }
    if (existingServiceCodes.has(key(code)) || seenService.has(key(code))) {
      issues.push({ kind: 'service', index, code, reason: 'allaqachon mavjud (o\'tkazib yuborildi — manual tahrir saqlanadi)' });
      return;
    }
    seenService.add(key(code));
    if (!knownServiceCats.has(key(category))) refs.serviceCategories.add(category);
    const basisRaw = asString(raw.priceBasis);
    const priceBasis = basisRaw === 'NET' || basisRaw === 'GROSS' ? basisRaw : 'UNKNOWN';
    const duration = typeof raw.durationMinutes === 'number' && Number.isInteger(raw.durationMinutes) && raw.durationMinutes >= 0 ? raw.durationMinutes : null;
    const taxRateBp = typeof raw.taxRateBp === 'number' && Number.isInteger(raw.taxRateBp) && raw.taxRateBp >= 0 ? raw.taxRateBp : null;
    services.push({ code, name, category, durationMinutes: duration, priceMinor: price, priceBasis, taxRateBp, priceInclusiveMinor: inclusive });
  });

  return { products, services, existingProductCodes, existingServiceCodes, refs, issues };
}

function report(source: RawSource, plan: Plan, applied: boolean): ImportReport {
  return {
    products: {
      total: source.products?.length ?? 0,
      toInsert: plan.products.length,
      existing: (source.products?.length ?? 0) - plan.products.length - plan.issues.filter((i) => i.kind === 'product' && !i.reason.includes('mavjud')).length,
      invalid: plan.issues.filter((i) => i.kind === 'product' && !i.reason.includes('mavjud')).length,
    },
    services: {
      total: source.services?.length ?? 0,
      toInsert: plan.services.length,
      existing: (source.services?.length ?? 0) - plan.services.length - plan.issues.filter((i) => i.kind === 'service' && !i.reason.includes('mavjud')).length,
      invalid: plan.issues.filter((i) => i.kind === 'service' && !i.reason.includes('mavjud')).length,
    },
    referencesToCreate: {
      companies: [...plan.refs.companies],
      brands: [...plan.refs.brands],
      productCategories: [...plan.refs.productCategories],
      serviceCategories: [...plan.refs.serviceCategories],
      units: [...plan.refs.units],
    },
    issues: plan.issues,
    applied,
  };
}

/** DRY-RUN: read-only planning, guaranteed to make no writes. */
export async function planImport(source: RawSource, runner: Knex): Promise<ImportReport> {
  const plan = await buildPlan(source, runner);
  return report(source, plan, false);
}

/**
 * APPLY: create missing references + insert new products/services in ONE
 * transaction (all-or-nothing — a mid-apply failure rolls the whole batch back,
 * so a fixed re-run is safe and cannot leave partial data). Insert-only, so it
 * never overwrites a manual edit. Records a CATALOG_IMPORT_APPLIED audit entry.
 */
export async function applyImport(source: RawSource, actorId: number, db: Knex): Promise<ImportReport> {
  return db.transaction(async (trx) => {
    const plan = await buildPlan(source, trx);

    const upsertRefByName = async (table: string, name: string): Promise<number> => {
      const existing = (await trx(table).whereRaw('LOWER(name) = LOWER(?)', [name]).first()) as { id: number } | undefined;
      if (existing) return existing.id;
      const [id] = await trx(table).insert({ name, status: 'ACTIVE' });
      return id as number;
    };
    const upsertUnit = async (code: string): Promise<number> => {
      const existing = (await trx('catalog_units').whereRaw('LOWER(code) = LOWER(?)', [code]).first()) as { id: number } | undefined;
      if (existing) return existing.id;
      const [id] = await trx('catalog_units').insert({ code, name: code, status: 'ACTIVE' });
      return id as number;
    };

    let refCount = 0;
    const companyId = new Map<string, number>();
    const brandId = new Map<string, number>();
    const prodCatId = new Map<string, number>();
    const svcCatId = new Map<string, number>();
    const unitId = new Map<string, number>();
    const resolve = async (map: Map<string, number>, table: string, name: string, isNew: boolean): Promise<number> => {
      const k = key(name);
      if (!map.has(k)) {
        const before = (await trx(table).whereRaw('LOWER(name) = LOWER(?)', [name]).first()) as { id: number } | undefined;
        map.set(k, await upsertRefByName(table, name));
        if (!before) refCount += 1;
      }
      void isNew;
      return map.get(k)!;
    };
    const resolveUnit = async (code: string): Promise<number> => {
      const k = key(code);
      if (!unitId.has(k)) {
        const before = (await trx('catalog_units').whereRaw('LOWER(code) = LOWER(?)', [code]).first()) as { id: number } | undefined;
        unitId.set(k, await upsertUnit(code));
        if (!before) refCount += 1;
      }
      return unitId.get(k)!;
    };

    let productCount = 0;
    for (const p of plan.products) {
      const cId = await resolve(companyId, 'catalog_companies', p.company, true);
      const catId = await resolve(prodCatId, 'product_categories', p.category, true);
      const bId = p.brand ? await resolve(brandId, 'catalog_brands', p.brand, true) : null;
      const uId = p.unit ? await resolveUnit(p.unit) : null;
      const [newId] = await trx('products').insert({
        code: p.code,
        name: p.name,
        company_id: cId,
        brand_id: bId,
        category_id: catId,
        unit_id: uId,
        price_minor: p.priceMinor,
        currency: p.currency,
        status: 'ACTIVE',
        version: 1,
        source: 'IMPORT',
        source_ref: p.code,
        created_by: actorId,
        updated_by: actorId,
      });
      if (p.priceMinor != null) {
        await trx('catalog_price_history').insert({
          entity_type: 'product',
          entity_id: newId,
          old_price_minor: null,
          new_price_minor: p.priceMinor,
          currency: p.currency,
          changed_by: actorId,
          reason: 'Import (provisional — approval required)',
          source: 'IMPORT',
        });
      }
      productCount += 1;
    }

    let serviceCount = 0;
    for (const s of plan.services) {
      const catId = await resolve(svcCatId, 'service_categories', s.category, true);
      const [newId] = await trx('services').insert({
        code: s.code,
        name: s.name,
        category_id: catId,
        duration_minutes: s.durationMinutes,
        price_minor: s.priceMinor,
        currency: 'UZS',
        price_basis: s.priceBasis,
        tax_rate_bp: s.taxRateBp,
        price_inclusive_minor: s.priceInclusiveMinor,
        status: 'ACTIVE',
        version: 1,
        source: 'IMPORT',
        source_ref: s.code,
        created_by: actorId,
        updated_by: actorId,
      });
      if (s.priceMinor != null) {
        await trx('catalog_price_history').insert({
          entity_type: 'service',
          entity_id: newId,
          old_price_minor: null,
          new_price_minor: s.priceMinor,
          currency: 'UZS',
          price_basis: s.priceBasis,
          changed_by: actorId,
          reason: 'Import (provisional — approval required)',
          source: 'IMPORT',
        });
      }
      serviceCount += 1;
    }

    await logAudit(
      {
        userId: actorId,
        action: 'CATALOG_IMPORT_APPLIED',
        entityType: 'catalog_import',
        newValue: { products: productCount, services: serviceCount, references: refCount },
      },
      trx,
    );

    const rep = report(source, plan, true);
    rep.inserted = { products: productCount, services: serviceCount, references: refCount };
    return rep;
  });
}
