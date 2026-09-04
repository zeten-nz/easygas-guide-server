/**
 * EASY GAS — Phase 3 customers + vehicles end-to-end tests.
 *
 * Runs the Express app in-process against the real MySQL dev database
 * (migrations + seeds must be applied first).
 *
 *   npm run test:cv
 *
 * Fixtures: users in the +99899000970x range, customers named "TEST CV ...",
 * plates prefixed TCV. Cleaned up before and after the run.
 */
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import { db } from '../src/config/database';
import { createApp } from '../src/app';
import { setSmsProviderForTesting } from '../src/sms';

const USERS = {
  usta: '+998990009701',
  ustaB: '+998990009702',
  sifat: '+998990009703',
  rahbar: '+998990009704',
};

const CUSTOMER_PHONES = {
  c1: '+998990009711',
  c2: '+998990009712',
  dupA: '+998990009713',
};

const PASSWORD = 'Sinov-parol-123';

let baseUrl = '';

interface HttpResult {
  status: number;
  body: any;
  setCookies: string[];
}

async function http(method: string, path: string, opts: { body?: unknown; cookie?: string } = {}): Promise<HttpResult> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(opts.cookie ? { cookie: opts.cookie } : {}) },
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

async function login(phone: string): Promise<string> {
  const res = await http('POST', '/api/v1/auth/login', { body: { phone, password: PASSWORD, rememberMe: false } });
  assert.equal(res.status, 200, `login failed for ${phone}`);
  const raw = res.setCookies.find((c) => c.startsWith('eg_session='));
  assert.ok(raw);
  return raw.split(';')[0];
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
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function cleanup(): Promise<void> {
  const testCustomerIds = (
    await db('customers').where('name', 'like', 'TEST CV%').select('id')
  ).map((c: { id: number }) => c.id);

  await db('vehicles').where('plate_number', 'like', 'TCV%').del();
  if (testCustomerIds.length > 0) {
    await db('vehicles').whereIn('customer_id', testCustomerIds).del();
    await db('audit_logs').where('entity_type', 'customer').whereIn('entity_id', testCustomerIds.map(String)).del();
    await db('customers').whereIn('id', testCustomerIds).del();
  }

  const users = await db('users').whereIn('phone', Object.values(USERS)).select('id');
  const userIds = users.map((u: { id: number }) => u.id);
  if (userIds.length > 0) {
    await db('audit_logs').whereIn('user_id', userIds).del();
    await db('sessions').whereIn('user_id', userIds).del();
  }
  await db('users').whereIn('phone', Object.values(USERS)).del();
}

async function createFixtures(): Promise<void> {
  const roles = await db('roles').select('id', 'code');
  const roleId = (code: string) => roles.find((r: { code: string }) => r.code === code)?.id;
  const branches = await db('branches').where({ status: 'ACTIVE' }).orderBy('id').limit(2);
  assert.ok(branches.length >= 2, 'need at least two active branches (seeded)');

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const base = { password_hash: passwordHash, region: 'Toshkent shahri' };

  await db('users').insert([
    { ...base, first_name: 'Cv', last_name: 'Usta', phone: USERS.usta, branch_id: branches[0].id, role_id: roleId('USTA'), status: 'ACTIVE' },
    { ...base, first_name: 'Cv', last_name: 'UstaB', phone: USERS.ustaB, branch_id: branches[1].id, role_id: roleId('USTA'), status: 'ACTIVE' },
    { ...base, first_name: 'Cv', last_name: 'Sifat', phone: USERS.sifat, branch_id: null, role_id: roleId('SIFAT'), status: 'ACTIVE' },
    { ...base, first_name: 'Cv', last_name: 'Rahbar', phone: USERS.rahbar, branch_id: branches[0].id, role_id: roleId('RAHBAR'), status: 'ACTIVE' },
  ]);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  setSmsProviderForTesting({ name: 'test-capture', send: async () => {} });
  await cleanup();
  await createFixtures();

  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;

  console.log(`\nRunning customers+vehicles E2E against ${baseUrl}\n`);

  const ustaCookie = await login(USERS.usta);
  const ustaBCookie = await login(USERS.ustaB);
  const sifatCookie = await login(USERS.sifat);
  const rahbarCookie = await login(USERS.rahbar);

  const ustaId = (await db('users').where({ phone: USERS.usta }).first()).id as number;

  // 1. Authorized create
  let customer1Id = 0;
  await test('USTA creates a customer (phone normalized, audited)', async () => {
    const res = await http('POST', '/api/v1/customers', {
      cookie: ustaCookie,
      body: { name: 'TEST CV Alisher Karimov', phone: '99 000 97 11' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    customer1Id = res.body.customer.id;
    assert.equal(res.body.customer.phone, CUSTOMER_PHONES.c1, 'phone must be normalized to +998...');
    assert.equal(res.body.customer.vehicleCount, 0);

    const row = await db('customers').where({ id: customer1Id }).first();
    assert.equal(row.name, 'TEST CV Alisher Karimov');
    assert.equal(row.created_by, ustaId);

    const audit = await db('audit_logs')
      .where({ action: 'CUSTOMER_CREATED', entity_type: 'customer', entity_id: String(customer1Id) })
      .first();
    assert.ok(audit, 'CUSTOMER_CREATED audit row must exist');
    assert.equal(audit.user_id, ustaId);
  });

  // 2. Unauthorized create
  await test('unauthenticated (401) and view-only roles (403) cannot create customers', async () => {
    assert.equal(
      (await http('POST', '/api/v1/customers', { body: { name: 'TEST CV X', phone: '99 000 97 19' } })).status,
      401,
    );
    for (const cookie of [sifatCookie, rahbarCookie]) {
      const res = await http('POST', '/api/v1/customers', {
        cookie,
        body: { name: 'TEST CV Ruxsatsiz', phone: '99 000 97 19' },
      });
      assert.equal(res.status, 403);
    }
    assert.equal(await db('customers').where({ name: 'TEST CV Ruxsatsiz' }).first(), undefined);
  });

  // 3. List
  await test('customer appears in the list', async () => {
    const res = await http('GET', '/api/v1/customers?limit=100', { cookie: ustaCookie });
    assert.equal(res.status, 200);
    assert.ok(res.body.customers.some((c: any) => c.id === customer1Id));
    assert.ok(typeof res.body.total === 'number' && res.body.total >= 1);
  });

  // 4. Search
  await test('customer search works by name fragment and phone digits', async () => {
    const byName = await http('GET', '/api/v1/customers?search=alisher', { cookie: ustaCookie });
    assert.ok(byName.body.customers.some((c: any) => c.id === customer1Id), 'case-insensitive name search');

    const byPhone = await http('GET', `/api/v1/customers?search=${encodeURIComponent('99 000 9711')}`, {
      cookie: ustaCookie,
    });
    assert.ok(byPhone.body.customers.some((c: any) => c.id === customer1Id), 'phone-digit search');

    const noHit = await http('GET', '/api/v1/customers?search=mavjudemasqidiruv', { cookie: ustaCookie });
    assert.equal(noHit.body.customers.length, 0);
  });

  // 5. Detail
  await test('customer can be opened by ID', async () => {
    const res = await http('GET', `/api/v1/customers/${customer1Id}`, { cookie: sifatCookie });
    assert.equal(res.status, 200);
    assert.equal(res.body.customer.name, 'TEST CV Alisher Karimov');
  });

  // 6. Update
  await test('customer can be updated (audited); view-only roles cannot', async () => {
    const res = await http('PATCH', `/api/v1/customers/${customer1Id}`, {
      cookie: ustaCookie,
      body: { name: 'TEST CV Alisher Karimov (yangilangan)' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.customer.name, 'TEST CV Alisher Karimov (yangilangan)');

    const audit = await db('audit_logs')
      .where({ action: 'CUSTOMER_UPDATED', entity_type: 'customer', entity_id: String(customer1Id) })
      .orderBy('id', 'desc')
      .first();
    assert.ok(audit, 'CUSTOMER_UPDATED audit row must exist');
    const changes = typeof audit.new_value === 'string' ? JSON.parse(audit.new_value) : audit.new_value;
    assert.ok(changes.name.old && changes.name.new, 'audit must contain old/new values');

    const denied = await http('PATCH', `/api/v1/customers/${customer1Id}`, {
      cookie: sifatCookie,
      body: { name: 'TEST CV Buzilgan' },
    });
    assert.equal(denied.status, 403);
    const row = await db('customers').where({ id: customer1Id }).first();
    assert.equal(row.name, 'TEST CV Alisher Karimov (yangilangan)', 'data must be untouched after denied mutation');
  });

  // 7-8. Vehicle creation + association
  let vehicle1Id = 0;
  let customer2Id = 0;
  await test('vehicle is created with normalized plate/VIN and linked to its customer', async () => {
    const res = await http('POST', '/api/v1/vehicles', {
      cookie: ustaCookie,
      body: {
        customerId: customer1Id,
        plateNumber: 'tcv 001 aa',
        vin: 'xta21099s1234567z',
        make: 'Chevrolet',
        model: 'Cobalt',
        year: 2022,
        engine: '1.5 benzin',
        mileage: 45000,
      },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    vehicle1Id = res.body.vehicle.id;
    assert.equal(res.body.vehicle.plateNumber, 'TCV001AA', 'plate must be normalized uppercase, no spaces');
    assert.equal(res.body.vehicle.vin, 'XTA21099S1234567Z', 'VIN must be uppercased');
    assert.equal(res.body.vehicle.customerId, customer1Id);

    const row = await db('vehicles').where({ id: vehicle1Id }).first();
    assert.equal(row.customer_id, customer1Id);
    assert.equal(row.created_by, ustaId);

    const audit = await db('audit_logs')
      .where({ action: 'VEHICLE_CREATED', entity_type: 'vehicle', entity_id: String(vehicle1Id) })
      .first();
    assert.ok(audit, 'VEHICLE_CREATED audit row must exist');
    assert.equal(audit.user_id, ustaId);
  });

  // 9. Customer's vehicle list
  await test("customer's vehicle list contains exactly their vehicles", async () => {
    const c2 = await http('POST', '/api/v1/customers', {
      cookie: ustaCookie,
      body: { name: 'TEST CV Bekzod Tashkentov', phone: '99 000 97 12' },
    });
    assert.equal(c2.status, 201);
    customer2Id = c2.body.customer.id;

    const v2 = await http('POST', '/api/v1/vehicles', {
      cookie: ustaCookie,
      body: { customerId: customer2Id, plateNumber: 'TCV002BB', make: 'Daewoo', model: 'Nexia' },
    });
    assert.equal(v2.status, 201);

    const list1 = await http('GET', `/api/v1/customers/${customer1Id}/vehicles`, { cookie: ustaCookie });
    assert.equal(list1.status, 200);
    assert.equal(list1.body.vehicles.length, 1);
    assert.equal(list1.body.vehicles[0].id, vehicle1Id);

    const list2 = await http('GET', `/api/v1/customers/${customer2Id}/vehicles`, { cookie: ustaCookie });
    assert.equal(list2.body.vehicles.length, 1);
    assert.equal(list2.body.vehicles[0].plateNumber, 'TCV002BB');

    const detail = await http('GET', `/api/v1/customers/${customer1Id}`, { cookie: ustaCookie });
    assert.equal(detail.body.customer.vehicleCount, 1);
  });

  // 10. Vehicle detail
  await test('vehicle can be opened and includes owner information', async () => {
    const res = await http('GET', `/api/v1/vehicles/${vehicle1Id}`, { cookie: rahbarCookie });
    assert.equal(res.status, 200);
    assert.equal(res.body.vehicle.customerName, 'TEST CV Alisher Karimov (yangilangan)');
    assert.equal(res.body.vehicle.customerPhone, CUSTOMER_PHONES.c1);
  });

  // 11. Vehicle update + transfer
  await test('vehicle can be updated and transferred to another customer (audited)', async () => {
    const res = await http('PATCH', `/api/v1/vehicles/${vehicle1Id}`, {
      cookie: ustaCookie,
      body: { mileage: 46500, engine: '1.5 benzin/gaz' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.vehicle.mileage, 46500);

    const audit = await db('audit_logs')
      .where({ action: 'VEHICLE_UPDATED', entity_type: 'vehicle', entity_id: String(vehicle1Id) })
      .orderBy('id', 'desc')
      .first();
    assert.ok(audit, 'VEHICLE_UPDATED audit row must exist');

    // Transfer (car sold): vehicle moves to customer2, record is NOT duplicated
    const transfer = await http('PATCH', `/api/v1/vehicles/${vehicle1Id}`, {
      cookie: ustaCookie,
      body: { customerId: customer2Id },
    });
    assert.equal(transfer.status, 200);
    assert.equal(transfer.body.vehicle.customerId, customer2Id);
    const list2 = await http('GET', `/api/v1/customers/${customer2Id}/vehicles`, { cookie: ustaCookie });
    assert.equal(list2.body.vehicles.length, 2);
    const count = await db('vehicles').where({ plate_number: 'TCV001AA' });
    assert.equal(count.length, 1, 'transfer must not duplicate the vehicle');

    // Transfer back for the remaining assertions
    await http('PATCH', `/api/v1/vehicles/${vehicle1Id}`, { cookie: ustaCookie, body: { customerId: customer1Id } });
  });

  // 12. Invalid customer IDs
  await test('invalid customer IDs are rejected', async () => {
    assert.equal((await http('GET', '/api/v1/customers/999999', { cookie: ustaCookie })).status, 404);
    assert.equal((await http('GET', '/api/v1/customers/abc', { cookie: ustaCookie })).status, 422);
    const badRef = await http('POST', '/api/v1/vehicles', {
      cookie: ustaCookie,
      body: { customerId: 999999, plateNumber: 'TCV003CC', make: 'Kia', model: 'K5' },
    });
    assert.equal(badRef.status, 400);
    assert.equal(badRef.body.error.code, 'INVALID_CUSTOMER');
  });

  // 13. Invalid vehicle IDs
  await test('invalid vehicle IDs are rejected', async () => {
    assert.equal((await http('GET', '/api/v1/vehicles/999999', { cookie: ustaCookie })).status, 404);
    assert.equal((await http('GET', '/api/v1/vehicles/abc', { cookie: ustaCookie })).status, 422);
    assert.equal((await http('GET', '/api/v1/customers/999999/vehicles', { cookie: ustaCookie })).status, 404);
  });

  // 14. Unauthorized direct-ID access / mutation
  await test('unauthorized direct-ID access and mutations are rejected', async () => {
    assert.equal((await http('GET', `/api/v1/customers/${customer1Id}`)).status, 401);
    assert.equal((await http('GET', `/api/v1/vehicles/${vehicle1Id}`)).status, 401);
    assert.equal(
      (await http('PATCH', `/api/v1/vehicles/${vehicle1Id}`, { cookie: sifatCookie, body: { mileage: 1 } })).status,
      403,
    );
    assert.equal(
      (await http('PATCH', `/api/v1/vehicles/${vehicle1Id}`, { cookie: rahbarCookie, body: { mileage: 1 } })).status,
      403,
    );
    const row = await db('vehicles').where({ id: vehicle1Id }).first();
    assert.equal(row.mileage, 46500, 'mileage must be untouched after denied mutations');
  });

  // 15. Global registry (documented decision: NOT branch-scoped)
  await test('vehicles are a global registry: another branch finds the same vehicle (no duplicates)', async () => {
    const search = await http('GET', `/api/v1/vehicles?search=${encodeURIComponent('tcv 001 aa')}`, {
      cookie: ustaBCookie,
    });
    assert.equal(search.status, 200);
    assert.ok(
      search.body.vehicles.some((v: any) => v.id === vehicle1Id),
      'branch-B usta must find the vehicle registered by branch A (loyiha.md §13 existing-vehicle flow)',
    );
    assert.equal((await http('GET', `/api/v1/customers/${customer1Id}`, { cookie: ustaBCookie })).status, 200);
  });

  // 16-17. Duplicate rules
  await test('duplicate plate and VIN are refused (409); duplicate customer phone is allowed', async () => {
    const dupPlate = await http('POST', '/api/v1/vehicles', {
      cookie: ustaCookie,
      body: { customerId: customer2Id, plateNumber: 'TCV-001-AA', make: 'Lada', model: 'Vesta' },
    });
    assert.equal(dupPlate.status, 409);
    assert.equal(dupPlate.body.error.code, 'PLATE_TAKEN');

    const dupVin = await http('POST', '/api/v1/vehicles', {
      cookie: ustaCookie,
      body: {
        customerId: customer2Id,
        plateNumber: 'TCV004DD',
        vin: 'XTA21099S1234567Z',
        make: 'Lada',
        model: 'Vesta',
      },
    });
    assert.equal(dupVin.status, 409);
    assert.equal(dupVin.body.error.code, 'VIN_TAKEN');

    const patchDup = await http('PATCH', `/api/v1/vehicles/${vehicle1Id}`, {
      cookie: ustaCookie,
      body: { plateNumber: 'TCV002BB' },
    });
    assert.equal(patchDup.status, 409, 'update to an existing plate must be refused');

    // Family members may share a phone — no uniqueness rule for customer phones
    const dup1 = await http('POST', '/api/v1/customers', {
      cookie: ustaCookie,
      body: { name: 'TEST CV Aka', phone: '99 000 97 13' },
    });
    const dup2 = await http('POST', '/api/v1/customers', {
      cookie: ustaCookie,
      body: { name: 'TEST CV Uka', phone: '99 000 97 13' },
    });
    assert.equal(dup1.status, 201);
    assert.equal(dup2.status, 201);
  });

  // 18. Audit completeness
  await test('all four Phase 3 audit actions are recorded with the actor', async () => {
    for (const action of ['CUSTOMER_CREATED', 'CUSTOMER_UPDATED', 'VEHICLE_CREATED', 'VEHICLE_UPDATED']) {
      const row = await db('audit_logs').where({ action, user_id: ustaId }).first();
      assert.ok(row, `missing audit action ${action}`);
    }
  });

  // 19. Pagination
  await test('pagination works with correct totals', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      name: `TEST CV Sahifa ${String(i + 1).padStart(2, '0')}`,
      phone: `+9989900098${String(i + 10).padStart(2, '0')}`,
    }));
    await db('customers').insert(rows);

    const search = 'TEST CV Sahifa';
    const page1 = await http('GET', `/api/v1/customers?search=${encodeURIComponent(search)}&limit=25&page=1`, {
      cookie: ustaCookie,
    });
    assert.equal(page1.status, 200);
    assert.equal(page1.body.total, 30);
    assert.equal(page1.body.customers.length, 25);

    const page2 = await http('GET', `/api/v1/customers?search=${encodeURIComponent(search)}&limit=25&page=2`, {
      cookie: ustaCookie,
    });
    assert.equal(page2.body.customers.length, 5);

    const ids1 = new Set(page1.body.customers.map((c: any) => c.id));
    assert.ok(page2.body.customers.every((c: any) => !ids1.has(c.id)), 'pages must not overlap');
  });

  // 20. Referential integrity for future Jobs
  await test('customer referenced by vehicles cannot be hard-deleted (FK RESTRICT)', async () => {
    await assert.rejects(
      db('customers').where({ id: customer1Id }).del(),
      /foreign key constraint/i,
      'DB must refuse deleting a customer that still owns vehicles',
    );
    assert.equal((await http('DELETE', `/api/v1/customers/${customer1Id}`, { cookie: ustaCookie })).status, 404);
    assert.equal((await http('DELETE', `/api/v1/vehicles/${vehicle1Id}`, { cookie: ustaCookie })).status, 404);
  });

  await cleanup();
  server.close();
  await db.destroy();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

run().catch(async (err) => {
  console.error(err);
  try {
    await db.destroy();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
