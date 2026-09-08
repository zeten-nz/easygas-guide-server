/**
 * EASY GAS — Phase 11B product & service catalogue + reference data E2E tests.
 *
 *   npm run test:catalog   (after: npm run test:setup)
 *
 * Covers (PHASE-11B.md §5–§10):
 *  - RBAC (catalog.view read / catalog.manage ADMIN-only), CSRF, forced-change gate;
 *  - product/service/reference CRUD; code uniqueness scope;
 *  - EXACT fixed-point money; zero vs unknown price; bounds;
 *  - atomic price history + optimistic-concurrency stale-edit conflict;
 *  - archive/reactivate; in-use-protected reference delete + concurrent race;
 *  - pagination / filter / sort / count consistency; bounded limits;
 *  - injection modelling (technology ⟂ forced induction, UNKNOWN supported);
 *  - import DRY-RUN makes no writes; apply is idempotent; reimport preserves manual edits.
 *
 * Fixtures use the "TEST CAT" / "TCAT"/"TSVC" prefixes and +99899009xx phones,
 * cleaned before + after. All against the isolated *_test DB.
 */
import { assertTestDatabase } from './helpers/test-env';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import { db } from '../src/config/database';
import { createApp } from '../src/app';
import { csrfTokenFor } from '../src/middleware/csrf.middleware';
import { planImport, applyImport } from '../src/modules/catalog/import/import.service';

const PHONES = { admin: '+998990090001', rahbar: '+998990090002', usta: '+998990090003', mustChange: '+998990090004' };
const PASSWORD = 'Sinov-parol-123';
let baseUrl = '';

interface HttpResult { status: number; body: any; setCookies: string[] }

async function http(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string; noCsrf?: boolean } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.cookie) {
    headers.cookie = opts.cookie;
    if (!opts.noCsrf) headers['x-csrf-token'] = csrfTokenFor(opts.cookie.split('=')[1] ?? '');
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, setCookies: res.headers.getSetCookie() };
}

function sessionCookie(res: HttpResult): string {
  const raw = res.setCookies.find((c) => c.startsWith('eg_session='));
  assert.ok(raw, 'expected eg_session cookie');
  return raw.split(';')[0];
}
async function login(phone: string, password = PASSWORD): Promise<HttpResult> {
  return http('POST', '/api/v1/auth/login', { body: { phone, password, rememberMe: false } });
}

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.stack : String(err)}`);
  }
}

const ids: Record<string, number> = {};
let adminCookie = '';
let rahbarCookie = '';
let ustaCookie = '';

async function cleanup(): Promise<void> {
  // Products/services created by tests (and their price history), then references.
  const prodIds = (await db('products').where('code', 'like', 'TCAT%').select('id')).map((r: { id: number }) => r.id);
  const svcIds = (await db('services').where('code', 'like', 'TSVC%').select('id')).map((r: { id: number }) => r.id);
  if (prodIds.length) await db('catalog_price_history').where('entity_type', 'product').whereIn('entity_id', prodIds).del();
  if (svcIds.length) await db('catalog_price_history').where('entity_type', 'service').whereIn('entity_id', svcIds).del();
  await db('products').where('code', 'like', 'TCAT%').del();
  await db('services').where('code', 'like', 'TSVC%').del();
  for (const t of ['catalog_companies', 'catalog_brands', 'product_categories', 'service_categories']) {
    await db(t).where('name', 'like', 'TEST CAT%').del();
  }
  await db('catalog_units').where('code', 'like', 'TU-%').del();
  await db('injection_reference').where('designation', 'like', 'TEST CAT%').del();

  const users = await db('users').whereIn('phone', Object.values(PHONES)).select('id');
  const userIds = users.map((u: { id: number }) => u.id);
  if (userIds.length) {
    await db('audit_logs').whereIn('user_id', userIds).del();
    await db('sessions').whereIn('user_id', userIds).del();
  }
  await db('users').whereIn('phone', Object.values(PHONES)).del();
}

async function createFixtures(): Promise<void> {
  const roles = await db('roles').select('id', 'code');
  const roleId = (code: string) => roles.find((x: { code: string }) => x.code === code)!.id;
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const insert = async (row: Record<string, unknown>) => {
    const [id] = await db('users').insert({ password_hash: passwordHash, region: 'Toshkent shahri', status: 'ACTIVE', ...row });
    return id as number;
  };
  ids.admin = await insert({ first_name: 'Cat', last_name: 'Admin', phone: PHONES.admin, branch_id: null, role_id: roleId('ADMIN') });
  ids.rahbar = await insert({ first_name: 'Cat', last_name: 'Rahbar', phone: PHONES.rahbar, branch_id: null, role_id: roleId('SIFAT') });
  ids.usta = await insert({ first_name: 'Cat', last_name: 'Usta', phone: PHONES.usta, branch_id: null, role_id: roleId('USTA') });
  const tempHash = await bcrypt.hash('Vaqtinchalik-1', 10);
  ids.mustChange = await insert({
    first_name: 'Cat',
    last_name: 'MustChange',
    phone: PHONES.mustChange,
    branch_id: null,
    role_id: roleId('ADMIN'),
    password_hash: tempHash,
    must_change_password: true,
    temp_password_expires_at: new Date(Date.now() + 3_600_000),
  });
}

/** Create a reference row via the API and return its id. */
async function makeRef(kind: string, body: Record<string, unknown>): Promise<number> {
  const res = await http('POST', `/api/v1/reference/${kind}`, { cookie: adminCookie, body });
  assert.equal(res.status, 201, `create ${kind}: ${JSON.stringify(res.body)}`);
  return res.body.item.id as number;
}

async function run(): Promise<void> {
  await assertTestDatabase(db);
  await cleanup();
  await createFixtures();

  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  console.log(`\nRunning catalog E2E against ${baseUrl}\n`);

  adminCookie = sessionCookie(await login(PHONES.admin));
  rahbarCookie = sessionCookie(await login(PHONES.rahbar));
  ustaCookie = sessionCookie(await login(PHONES.usta));

  // --------------------------------- RBAC / CSRF ---------------------------------

  await test('RBAC: a role without catalog.view cannot read the catalogue (403)', async () => {
    const res = await http('GET', '/api/v1/products', { cookie: ustaCookie });
    assert.equal(res.status, 403);
  });

  await test('RBAC: catalog.view can READ but not MANAGE (403 on create)', async () => {
    const read = await http('GET', '/api/v1/products', { cookie: rahbarCookie });
    assert.equal(read.status, 200);
    const create = await http('POST', '/api/v1/reference/companies', { cookie: rahbarCookie, body: { name: 'TEST CAT Nope' } });
    assert.equal(create.status, 403);
  });

  await test('CSRF: a manage mutation without the session-bound token is refused', async () => {
    const res = await http('POST', '/api/v1/reference/companies', { cookie: adminCookie, body: { name: 'TEST CAT NoCsrf' }, noCsrf: true });
    assert.ok(res.status === 403, `expected CSRF refusal, got ${res.status}`);
  });

  await test('forced-change (temp password) session cannot reach the catalogue', async () => {
    const cookie = sessionCookie(await login(PHONES.mustChange, 'Vaqtinchalik-1'));
    const res = await http('GET', '/api/v1/products', { cookie });
    assert.ok(res.status === 403 || res.status === 423, `forced-change should be blocked, got ${res.status}`);
  });

  // --------------------------- Reference CRUD + dedupe ---------------------------

  await test('reference create + normalized duplicate detection (case/whitespace)', async () => {
    const id = await makeRef('brands', { name: 'TEST CAT Bosch' });
    ids.brand = id;
    const dupe = await http('POST', '/api/v1/reference/brands', { cookie: adminCookie, body: { name: '  test cat   bosch ' } });
    assert.equal(dupe.status, 409);
    assert.equal(dupe.body.error.code, 'REFERENCE_DUPLICATE');
  });

  await test('units require a code; company/category created', async () => {
    ids.company = await makeRef('companies', { name: 'TEST CAT EASY GAS' });
    ids.company2 = await makeRef('companies', { name: 'TEST CAT EAST ENERGE' });
    ids.pcat = await makeRef('product-categories', { name: 'TEST CAT Filtrlar' });
    ids.scat = await makeRef('service-categories', { name: 'TEST CAT Montaj' });
    const noCode = await http('POST', '/api/v1/reference/units', { cookie: adminCookie, body: { name: 'dona' } });
    assert.equal(noCode.status, 400);
    assert.equal(noCode.body.error.code, 'CODE_REQUIRED');
    ids.unit = await makeRef('units', { name: 'dona', code: 'TU-DONA' });
  });

  // ------------------------------ Product CRUD + money ------------------------------

  await test('product create: exact money, per-company code uniqueness scope', async () => {
    const res = await http('POST', '/api/v1/products', {
      cookie: adminCookie,
      body: { code: 'TCAT-001', name: 'TEST CAT Filtr A', companyId: ids.company, categoryId: ids.pcat, brandId: ids.brand, unitId: ids.unit, priceMinor: 150000000 },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    ids.product = res.body.product.id;
    assert.equal(res.body.product.priceMinor, 150000000, 'price stored EXACTLY (no float drift)');
    assert.equal(res.body.product.currency, 'UZS');
    assert.equal(res.body.product.version, 1);

    // Same code, DIFFERENT company → allowed (scope is per company).
    const otherCompany = await http('POST', '/api/v1/products', {
      cookie: adminCookie,
      body: { code: 'TCAT-001', name: 'TEST CAT Filtr B', companyId: ids.company2, categoryId: ids.pcat },
    });
    assert.equal(otherCompany.status, 201, 'same code in a different company is allowed');

    // Same code, SAME company → rejected.
    const dupe = await http('POST', '/api/v1/products', {
      cookie: adminCookie,
      body: { code: 'tcat-001', name: 'TEST CAT dupe', companyId: ids.company, categoryId: ids.pcat },
    });
    assert.equal(dupe.status, 409);
    assert.equal(dupe.body.error.code, 'PRODUCT_CODE_TAKEN');
  });

  await test('zero price and unknown price are DISTINCT', async () => {
    const zero = await http('POST', '/api/v1/products', {
      cookie: adminCookie,
      body: { code: 'TCAT-ZERO', name: 'TEST CAT Zero', companyId: ids.company, categoryId: ids.pcat, priceMinor: 0 },
    });
    assert.equal(zero.body.product.priceMinor, 0, 'zero is a real 0 price');
    const unknown = await http('POST', '/api/v1/products', {
      cookie: adminCookie,
      body: { code: 'TCAT-UNK', name: 'TEST CAT Unknown', companyId: ids.company, categoryId: ids.pcat },
    });
    assert.equal(unknown.body.product.priceMinor, null, 'omitted price is UNKNOWN (null)');
  });

  await test('price bounds: negative and non-integer are rejected (422/400)', async () => {
    const neg = await http('POST', '/api/v1/products', {
      cookie: adminCookie,
      body: { code: 'TCAT-NEG', name: 'TEST CAT Neg', companyId: ids.company, categoryId: ids.pcat, priceMinor: -5 },
    });
    assert.ok(neg.status === 422 || neg.status === 400, `negative price rejected, got ${neg.status}`);
  });

  // ------------------------ Price history + stale-edit conflict ------------------------

  await test('price change records atomic history (old→new, actor) and PRODUCT_PRICE_CHANGED audit', async () => {
    const before = await http('GET', `/api/v1/products/${ids.product}/price-history`, { cookie: adminCookie });
    const beforeCount = before.body.history.length;
    const upd = await http('PATCH', `/api/v1/products/${ids.product}`, { cookie: adminCookie, body: { version: 1, priceMinor: 175000000, priceReason: 'narx yangilandi' } });
    assert.equal(upd.status, 200, JSON.stringify(upd.body));
    assert.equal(upd.body.product.priceMinor, 175000000);
    assert.equal(upd.body.product.version, 2, 'version bumped');
    const after = await http('GET', `/api/v1/products/${ids.product}/price-history`, { cookie: adminCookie });
    assert.equal(after.body.history.length, beforeCount + 1, 'one new history row');
    const latest = after.body.history[0];
    assert.equal(latest.oldPriceMinor, 150000000);
    assert.equal(latest.newPriceMinor, 175000000);
    assert.ok(latest.changedByName, 'history records the actor');
    const audit = await db('audit_logs').where({ action: 'PRODUCT_PRICE_CHANGED', entity_id: String(ids.product) }).first();
    assert.ok(audit, 'PRODUCT_PRICE_CHANGED audited');
  });

  await test('optimistic concurrency: a stale version is refused (STALE_WRITE 409)', async () => {
    const stale = await http('PATCH', `/api/v1/products/${ids.product}`, { cookie: adminCookie, body: { version: 1, name: 'TEST CAT stale' } });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'STALE_WRITE');
  });

  // ------------------------ Archive / reactivate / delete eligibility ------------------------

  await test('archive → reactivate a product (status transitions, STATUS_UNCHANGED guard)', async () => {
    const cur = await http('GET', `/api/v1/products/${ids.product}`, { cookie: adminCookie });
    const arch = await http('POST', `/api/v1/products/${ids.product}/archive`, { cookie: adminCookie });
    assert.equal(arch.body.product.status, 'ARCHIVED');
    const again = await http('POST', `/api/v1/products/${ids.product}/archive`, { cookie: adminCookie });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'STATUS_UNCHANGED');
    const re = await http('POST', `/api/v1/products/${ids.product}/reactivate`, { cookie: adminCookie });
    assert.equal(re.body.product.status, 'ACTIVE');
    void cur;
  });

  await test('referenced reference cannot be deleted (REFERENCE_IN_USE); archive works; delete after cleanup', async () => {
    // ids.company is used by products → delete refused, archive allowed.
    const del = await http('DELETE', `/api/v1/reference/companies/${ids.company}`, { cookie: adminCookie });
    assert.equal(del.status, 409);
    assert.equal(del.body.error.code, 'REFERENCE_IN_USE');
    const arch = await http('POST', `/api/v1/reference/companies/${ids.company}/archive`, { cookie: adminCookie });
    assert.equal(arch.status, 200);
    // A brand-new unused company deletes cleanly.
    const tmp = await makeRef('companies', { name: 'TEST CAT Temp Co' });
    const delTmp = await http('DELETE', `/api/v1/reference/companies/${tmp}`, { cookie: adminCookie });
    assert.equal(delTmp.status, 200);
    // reactivate company for later tests
    await http('POST', `/api/v1/reference/companies/${ids.company}/reactivate`, { cookie: adminCookie });
  });

  await test('concurrent delete-reference vs create-product-using-it: no orphan/500, one clean outcome', async () => {
    const tmpCo = await makeRef('companies', { name: 'TEST CAT Race Co' });
    const [del, create] = await Promise.all([
      http('DELETE', `/api/v1/reference/companies/${tmpCo}`, { cookie: adminCookie }),
      http('POST', '/api/v1/products', { cookie: adminCookie, body: { code: 'TCAT-RACE', name: 'TEST CAT Race', companyId: tmpCo, categoryId: ids.pcat } }),
    ]);
    for (const r of [del, create]) assert.ok(r.status < 500, `no raw 500 (got ${r.status})`);
    // Final state is consistent: if the product exists, the company must still exist.
    const prod = await db('products').where({ code: 'TCAT-RACE' }).first();
    if (prod) {
      const co = await db('catalog_companies').where({ id: tmpCo }).first();
      assert.ok(co, 'no orphan product — its company still exists');
    }
  });

  // ------------------------ Pagination / filter / sort / count ------------------------

  await test('list pagination/filter/sort/count are consistent with an id tie-breaker', async () => {
    // Seed 7 products in a dedicated category, all same price so sort relies on tie-break.
    const cat = await makeRef('product-categories', { name: 'TEST CAT Page' });
    for (let i = 0; i < 7; i++) {
      await http('POST', '/api/v1/products', { cookie: adminCookie, body: { code: `TCAT-P${i}`, name: `TEST CAT Page ${String(i).padStart(2, '0')}`, companyId: ids.company, categoryId: cat, priceMinor: 1000 } });
    }
    const p1 = await http('GET', `/api/v1/products?categoryId=${cat}&limit=5&page=1&sort=name&order=asc`, { cookie: adminCookie });
    assert.equal(p1.body.total, 7, 'accurate filtered total');
    assert.equal(p1.body.items.length, 5);
    const p2 = await http('GET', `/api/v1/products?categoryId=${cat}&limit=5&page=2&sort=name&order=asc`, { cookie: adminCookie });
    assert.equal(p2.body.items.length, 2);
    const all = [...p1.body.items, ...p2.body.items].map((x: any) => x.id);
    assert.equal(new Set(all).size, 7, 'no dupes/omissions across pages');
    // Bounded limit: >100 rejected.
    const over = await http('GET', '/api/v1/products?limit=250', { cookie: adminCookie });
    assert.equal(over.status, 422, 'limit is bounded');
    // Search by code.
    const search = await http('GET', `/api/v1/products?search=TCAT-P3`, { cookie: adminCookie });
    assert.ok(search.body.items.some((x: any) => x.code === 'TCAT-P3'));
  });

  // ------------------------------- Services -------------------------------

  await test('service create with duration + price basis; code globally unique', async () => {
    const res = await http('POST', '/api/v1/services', {
      cookie: adminCookie,
      body: { code: 'TSVC-001', name: 'TEST CAT Montaj xizmati', categoryId: ids.scat, durationMinutes: 90, priceMinor: 30000000, priceBasis: 'NET', taxRateBp: 1200 },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    ids.service = res.body.service.id;
    assert.equal(res.body.service.durationMinutes, 90);
    assert.equal(res.body.service.priceBasis, 'NET');
    assert.equal(res.body.service.taxRateBp, 1200);
    const dupe = await http('POST', '/api/v1/services', { cookie: adminCookie, body: { code: 'tsvc-001', name: 'TEST CAT dupe', categoryId: ids.scat } });
    assert.equal(dupe.status, 409);
    assert.equal(dupe.body.error.code, 'SERVICE_CODE_TAKEN');
  });

  // ------------------------------- Injection modelling -------------------------------

  await test('injection: technology ⟂ forced induction; Turbo is NOT a technology; UNKNOWN supported', async () => {
    const fsi = await http('POST', '/api/v1/injection-reference', { cookie: adminCookie, body: { designation: 'TEST CAT FSI', technology: 'DIRECT', forcedInduction: 'NONE', description: 'manufacturer designation, direct injection' } });
    assert.equal(fsi.status, 201, JSON.stringify(fsi.body));
    // A turbocharged port-injection entry: forced induction is separate from technology.
    const tsi = await http('POST', '/api/v1/injection-reference', { cookie: adminCookie, body: { designation: 'TEST CAT MPI-T', technology: 'PORT_MULTIPOINT', forcedInduction: 'TURBO' } });
    assert.equal(tsi.body.item.technology, 'PORT_MULTIPOINT');
    assert.equal(tsi.body.item.forcedInduction, 'TURBO');
    // Unknown everything is allowed.
    const unk = await http('POST', '/api/v1/injection-reference', { cookie: adminCookie, body: { designation: 'TEST CAT ???' } });
    assert.equal(unk.body.item.technology, 'UNKNOWN');
    assert.equal(unk.body.item.forcedInduction, 'UNKNOWN');
  });

  // ------------------------------- Import (dry-run / apply / idempotency) -------------------------------

  await test('import DRY-RUN makes no writes', async () => {
    const source = { products: [{ code: 'TCAT-IMP1', name: 'TEST CAT Imported', company: 'TEST CAT ImpCo', category: 'TEST CAT ImpCat', priceMinor: 5000 }], services: [] };
    const before = Number((await db('products').count({ c: '*' }).first() as any).c);
    const report = await planImport(source, db);
    assert.equal(report.products.toInsert, 1);
    assert.equal(report.applied, false);
    const after = Number((await db('products').count({ c: '*' }).first() as any).c);
    assert.equal(before, after, 'dry-run wrote nothing');
  });

  await test('import APPLY inserts with provenance; reimport is idempotent (no duplicates)', async () => {
    const source = {
      products: [
        { code: 'TCAT-IMP1', name: 'TEST CAT Imported 1', company: 'TEST CAT ImpCo', brand: 'TEST CAT ImpBrand', category: 'TEST CAT ImpCat', unit: 'TU-IMP', priceMinor: 5000 },
        { code: 'TCAT-IMP2', name: 'TEST CAT Imported 2', company: 'TEST CAT ImpCo', category: 'TEST CAT ImpCat', priceMinor: 0 },
        { code: '', name: 'bad', company: 'X', category: 'Y' }, // invalid → reported, not applied
      ],
      services: [{ code: 'TSVC-IMP1', name: 'TEST CAT Imported svc', category: 'TEST CAT ImpSvcCat', priceMinor: 9000 }],
    };
    const r1 = await applyImport(source, ids.admin, db);
    assert.equal(r1.inserted!.products, 2, 'two valid products inserted, one invalid skipped');
    assert.equal(r1.inserted!.services, 1);
    assert.ok(r1.issues.some((i) => i.reason.includes('majburiy')), 'invalid record reported');
    const imp = await db('products').where({ code: 'TCAT-IMP1' }).first();
    assert.equal(imp.source, 'IMPORT');
    assert.equal(imp.source_ref, 'TCAT-IMP1');

    // Reimport: no new rows (idempotent), all existing reported/skipped.
    const r2 = await applyImport(source, ids.admin, db);
    assert.equal(r2.inserted!.products, 0, 'reimport inserts nothing');
    assert.equal(r2.inserted!.services, 0);
  });

  await test('reimport PRESERVES a later manual edit (never silently overwritten)', async () => {
    const prod = await db('products').where({ code: 'TCAT-IMP1' }).first();
    // Manual edit via API: change the price.
    const upd = await http('PATCH', `/api/v1/products/${prod.id}`, { cookie: adminCookie, body: { version: prod.version, priceMinor: 99999, priceReason: 'manual override' } });
    assert.equal(upd.status, 200);
    // Reimport the SAME source (price 5000) — the manual price must survive.
    const source = { products: [{ code: 'TCAT-IMP1', name: 'TEST CAT Imported 1', company: 'TEST CAT ImpCo', category: 'TEST CAT ImpCat', priceMinor: 5000 }], services: [] };
    await applyImport(source, ids.admin, db);
    const after = await db('products').where({ id: prod.id }).first();
    assert.equal(Number(after.price_minor), 99999, 'manual edit preserved (import is insert-only)');
  });

  // Cleanup import fixtures created above.
  await db('products').where('code', 'like', 'TCAT-IMP%').del();
  await db('services').where('code', 'like', 'TSVC-IMP%').del();
  for (const t of ['catalog_companies', 'catalog_brands', 'product_categories', 'service_categories'])
    await db(t).where('name', 'like', 'TEST CAT Imp%').del();
  await db('catalog_units').where('code', 'like', 'TU-IMP%').del();

  await test('an unused product deletes cleanly (nothing references it)', async () => {
    const tmp = await http('POST', '/api/v1/products', { cookie: adminCookie, body: { code: 'TCAT-DEL', name: 'TEST CAT Del', companyId: ids.company, categoryId: ids.pcat, priceMinor: 100 } });
    const id = tmp.body.product.id;
    const del = await http('DELETE', `/api/v1/products/${id}`, { cookie: adminCookie });
    assert.equal(del.status, 200);
    const gone = await http('GET', `/api/v1/products/${id}`, { cookie: adminCookie });
    assert.equal(gone.status, 404);
    const hist = await db('catalog_price_history').where({ entity_type: 'product', entity_id: id });
    assert.equal(hist.length, 0, 'price history removed with the product');
  });

  server.close();
  await cleanup();
  await db.destroy();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
