/**
 * EASY GAS — Phase 4 job management end-to-end tests.
 *
 * Runs the Express app in-process against the real MySQL dev database
 * (migrations + seeds must be applied first).
 *
 *   npm run test:jobs
 *
 * Fixtures: users +99899000960x, branches "TEST JOB ...", customers
 * "TEST JOB ...", plates TJB*. Cleaned up before and after the run.
 */
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import { db } from '../src/config/database';
import { createApp } from '../src/app';
import { setSmsProviderForTesting } from '../src/sms';

const USERS = {
  ustaA: '+998990009601',
  masterA: '+998990009602',
  ustaB: '+998990009603',
  rahbarA: '+998990009604',
  sifat: '+998990009605',
  admin: '+998990009606',
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
  const jobIds = (
    await db('jobs')
      .join('vehicles', 'vehicles.id', 'jobs.vehicle_id')
      .where('vehicles.plate_number', 'like', 'TJB%')
      .select('jobs.id')
  ).map((j: { id: number }) => j.id);
  if (jobIds.length > 0) {
    await db('audit_logs').where('entity_type', 'job').whereIn('entity_id', jobIds.map(String)).del();
    await db('jobs').whereIn('id', jobIds).del();
  }

  const customerIds = (await db('customers').where('name', 'like', 'TEST JOB%').select('id')).map(
    (c: { id: number }) => c.id,
  );
  await db('vehicles').where('plate_number', 'like', 'TJB%').del();
  if (customerIds.length > 0) {
    await db('audit_logs').where('entity_type', 'customer').whereIn('entity_id', customerIds.map(String)).del();
    await db('customers').whereIn('id', customerIds).del();
  }

  const users = await db('users').whereIn('phone', Object.values(USERS)).select('id');
  const userIds = users.map((u: { id: number }) => u.id);
  if (userIds.length > 0) {
    await db('audit_logs').whereIn('user_id', userIds).del();
    await db('sessions').whereIn('user_id', userIds).del();
  }
  await db('users').whereIn('phone', Object.values(USERS)).del();

  const branchIds = (await db('branches').where('name', 'like', 'TEST JOB%').select('id')).map(
    (b: { id: number }) => String(b.id),
  );
  if (branchIds.length > 0) {
    await db('audit_logs').where('entity_type', 'branch').whereIn('entity_id', branchIds).del();
  }
  await db('branches').where('name', 'like', 'TEST JOB%').del();
}

interface Fixtures {
  branchA: number;
  branchB: number;
  ids: Record<string, number>;
}

async function createFixtures(): Promise<Fixtures> {
  const roles = await db('roles').select('id', 'code');
  const roleId = (code: string) => roles.find((r: { code: string }) => r.code === code)?.id;

  const [branchA] = await db('branches').insert({ name: 'TEST JOB Branch A', region: 'Toshkent shahri', status: 'ACTIVE' });
  const [branchB] = await db('branches').insert({ name: 'TEST JOB Branch B', region: 'Samarqand', status: 'ACTIVE' });

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const base = { password_hash: passwordHash, region: 'Toshkent shahri', status: 'ACTIVE' };

  const insert = async (row: Record<string, unknown>) => {
    const [id] = await db('users').insert(row);
    return id as number;
  };

  const ids: Record<string, number> = {};
  ids.ustaA = await insert({ ...base, first_name: 'Job', last_name: 'UstaA', phone: USERS.ustaA, branch_id: branchA, role_id: roleId('USTA') });
  ids.masterA = await insert({ ...base, first_name: 'Job', last_name: 'MasterA', phone: USERS.masterA, branch_id: branchA, role_id: roleId('MASTER') });
  ids.ustaB = await insert({ ...base, first_name: 'Job', last_name: 'UstaB', phone: USERS.ustaB, branch_id: branchB, role_id: roleId('USTA') });
  ids.rahbarA = await insert({ ...base, first_name: 'Job', last_name: 'RahbarA', phone: USERS.rahbarA, branch_id: branchA, role_id: roleId('RAHBAR') });
  ids.sifat = await insert({ ...base, first_name: 'Job', last_name: 'Sifat', phone: USERS.sifat, branch_id: null, role_id: roleId('SIFAT') });
  ids.admin = await insert({ ...base, first_name: 'Job', last_name: 'Admin', phone: USERS.admin, branch_id: null, role_id: roleId('ADMIN') });

  return { branchA: branchA as number, branchB: branchB as number, ids };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  setSmsProviderForTesting({ name: 'test-capture', send: async () => {} });
  await cleanup();
  const fx = await createFixtures();

  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;

  console.log(`\nRunning jobs E2E against ${baseUrl}\n`);

  const ustaACookie = await login(USERS.ustaA);
  const masterACookie = await login(USERS.masterA);
  const ustaBCookie = await login(USERS.ustaB);
  const rahbarACookie = await login(USERS.rahbarA);
  const sifatCookie = await login(USERS.sifat);
  const adminCookie = await login(USERS.admin);

  // Setup customers + vehicles through the real Phase 3 API
  const c1 = await http('POST', '/api/v1/customers', {
    cookie: ustaACookie,
    body: { name: 'TEST JOB Anvar Rustamov', phone: '99 000 96 11' },
  });
  assert.equal(c1.status, 201);
  const customer1Id = c1.body.customer.id as number;

  const c2 = await http('POST', '/api/v1/customers', {
    cookie: ustaACookie,
    body: { name: 'TEST JOB Sardor Aliyev', phone: '99 000 96 12' },
  });
  const customer2Id = c2.body.customer.id as number;

  const v1 = await http('POST', '/api/v1/vehicles', {
    cookie: ustaACookie,
    body: { customerId: customer1Id, plateNumber: 'TJB001AA', make: 'Chevrolet', model: 'Cobalt', year: 2021 },
  });
  assert.equal(v1.status, 201);
  const vehicle1Id = v1.body.vehicle.id as number;

  const v2 = await http('POST', '/api/v1/vehicles', {
    cookie: ustaACookie,
    body: { customerId: customer2Id, plateNumber: 'TJB002BB', make: 'Daewoo', model: 'Nexia' },
  });
  const vehicle2Id = v2.body.vehicle.id as number;

  const customerCountBefore = Number(((await db('customers').count({ c: '*' })) as any)[0].c);
  const vehicleCountBefore = Number(((await db('vehicles').count({ c: '*' })) as any)[0].c);

  // 1. USTA creates a job
  let job1Id = 0;
  await test('USTA creates a job: DRAFT, own branch, creator recorded, audited', async () => {
    const res = await http('POST', '/api/v1/jobs', {
      cookie: ustaACookie,
      body: { customerId: customer1Id, vehicleId: vehicle1Id },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    job1Id = res.body.job.id;
    assert.equal(res.body.job.status, 'DRAFT');
    assert.equal(res.body.job.branchId, fx.branchA, 'job must belong to the creator branch');
    assert.equal(res.body.job.createdById, fx.ids.ustaA);
    assert.equal(res.body.job.plateNumber, 'TJB001AA');

    const row = await db('jobs').where({ id: job1Id }).first();
    assert.equal(row.status, 'DRAFT');
    assert.equal(row.branch_id, fx.branchA);
    assert.equal(row.created_by, fx.ids.ustaA);

    const audit = await db('audit_logs')
      .where({ action: 'JOB_CREATED', entity_type: 'job', entity_id: String(job1Id) })
      .first();
    assert.ok(audit, 'JOB_CREATED audit row must exist');
    assert.equal(audit.user_id, fx.ids.ustaA);
  });

  // 2. Client-sent branch/status are never trusted
  await test('client-sent branchId/status are ignored (branch from session, status DRAFT)', async () => {
    const res = await http('POST', '/api/v1/jobs', {
      cookie: ustaACookie,
      body: { customerId: customer2Id, vehicleId: vehicle2Id, branchId: fx.branchB, status: 'COMPLETED' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.job.branchId, fx.branchA, 'client-sent branchId must be ignored');
    assert.equal(res.body.job.status, 'DRAFT', 'client-sent status must be ignored');
  });

  // 3. MASTER creates a job
  let masterJobId = 0;
  await test('MASTER creates a job in their own branch', async () => {
    const res = await http('POST', '/api/v1/jobs', {
      cookie: masterACookie,
      body: { customerId: customer1Id, vehicleId: vehicle1Id },
    });
    assert.equal(res.status, 201);
    masterJobId = res.body.job.id;
    assert.equal(res.body.job.branchId, fx.branchA);
    assert.equal(res.body.job.createdById, fx.ids.masterA);
  });

  // 4. Unauthorized roles cannot create
  await test('RAHBAR, SIFAT and ADMIN cannot create jobs (403, per §4 matrix)', async () => {
    for (const cookie of [rahbarACookie, sifatCookie, adminCookie]) {
      const res = await http('POST', '/api/v1/jobs', {
        cookie,
        body: { customerId: customer1Id, vehicleId: vehicle1Id },
      });
      assert.equal(res.status, 403);
    }
    assert.equal((await http('POST', '/api/v1/jobs', { body: { customerId: 1, vehicleId: 1 } })).status, 401);
  });

  // 5. Customer/vehicle must exist
  await test('nonexistent customer or vehicle is rejected', async () => {
    const badCustomer = await http('POST', '/api/v1/jobs', {
      cookie: ustaACookie,
      body: { customerId: 999999, vehicleId: vehicle1Id },
    });
    assert.equal(badCustomer.status, 400);
    assert.equal(badCustomer.body.error.code, 'INVALID_CUSTOMER');

    const badVehicle = await http('POST', '/api/v1/jobs', {
      cookie: ustaACookie,
      body: { customerId: customer1Id, vehicleId: 999999 },
    });
    assert.equal(badVehicle.status, 400);
    assert.equal(badVehicle.body.error.code, 'INVALID_VEHICLE');
  });

  // 6. Vehicle must belong to the selected customer
  await test('vehicle belonging to a different customer is rejected', async () => {
    const res = await http('POST', '/api/v1/jobs', {
      cookie: ustaACookie,
      body: { customerId: customer1Id, vehicleId: vehicle2Id },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VEHICLE_CUSTOMER_MISMATCH');
    const count = await db('jobs').where({ vehicle_id: vehicle2Id, customer_id: customer1Id });
    assert.equal(count.length, 0, 'no mismatched job may exist');
  });

  // 7-8. List + detail
  await test('job appears in list and detail loads with joined data', async () => {
    const list = await http('GET', '/api/v1/jobs?limit=100', { cookie: ustaACookie });
    assert.equal(list.status, 200);
    assert.ok(list.body.jobs.some((j: any) => j.id === job1Id));

    const detail = await http('GET', `/api/v1/jobs/${job1Id}`, { cookie: ustaACookie });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.job.customerName, 'TEST JOB Anvar Rustamov');
    assert.equal(detail.body.job.plateNumber, 'TJB001AA');
    assert.equal(detail.body.job.branchName, 'TEST JOB Branch A');
    assert.equal(detail.body.job.createdByName, 'Job UstaA');
  });

  // 9. Search
  await test('search works by plate, customer name, phone digits and #id', async () => {
    const byPlate = await http('GET', `/api/v1/jobs?search=${encodeURIComponent('tjb 001 aa')}`, { cookie: ustaACookie });
    assert.ok(byPlate.body.jobs.some((j: any) => j.id === job1Id), 'plate search (formatting-insensitive)');

    const byName = await http('GET', '/api/v1/jobs?search=anvar', { cookie: ustaACookie });
    assert.ok(byName.body.jobs.some((j: any) => j.id === job1Id), 'customer name search');

    const byPhone = await http('GET', `/api/v1/jobs?search=${encodeURIComponent('99 000 9611')}`, { cookie: ustaACookie });
    assert.ok(byPhone.body.jobs.some((j: any) => j.id === job1Id), 'customer phone search');

    const byId = await http('GET', `/api/v1/jobs?search=${encodeURIComponent(`#${job1Id}`)}`, { cookie: ustaACookie });
    assert.ok(byId.body.jobs.some((j: any) => j.id === job1Id), 'job number search');
  });

  // 10. Status filter
  await test('status filter works', async () => {
    const drafts = await http('GET', '/api/v1/jobs?status=DRAFT&limit=100', { cookie: ustaACookie });
    assert.ok(drafts.body.jobs.every((j: any) => j.status === 'DRAFT'));
    assert.ok(drafts.body.jobs.some((j: any) => j.id === job1Id));
    const completed = await http('GET', '/api/v1/jobs?status=COMPLETED&limit=100', { cookie: ustaACookie });
    assert.equal(completed.body.jobs.length, 0);
  });

  // 11. Branch isolation
  await test('branch isolation: lists are confined per §11 (USTA/MASTER/RAHBAR own branch; SIFAT/ADMIN all)', async () => {
    const listB = await http('GET', '/api/v1/jobs?limit=100', { cookie: ustaBCookie });
    assert.equal(listB.body.jobs.length, 0, 'branch-B usta must see no branch-A jobs');

    const widen = await http('GET', `/api/v1/jobs?limit=100&branchId=${fx.branchA}`, { cookie: ustaBCookie });
    assert.equal(widen.body.jobs.length, 0, 'branchId filter must never widen a confined scope');

    const rahbarList = await http('GET', '/api/v1/jobs?limit=100', { cookie: rahbarACookie });
    assert.ok(rahbarList.body.jobs.some((j: any) => j.id === job1Id), 'rahbar sees own-branch jobs');

    const sifatList = await http('GET', '/api/v1/jobs?limit=100', { cookie: sifatCookie });
    assert.ok(sifatList.body.jobs.some((j: any) => j.id === job1Id), 'sifat sees all branches');

    const adminFiltered = await http('GET', `/api/v1/jobs?limit=100&branchId=${fx.branchB}`, { cookie: adminCookie });
    assert.ok(adminFiltered.body.jobs.every((j: any) => j.branchId === fx.branchB), 'admin branch filter works');
  });

  // 12. IDOR
  await test('direct-ID cross-branch access is rejected (404), in-scope viewers succeed', async () => {
    assert.equal((await http('GET', `/api/v1/jobs/${job1Id}`, { cookie: ustaBCookie })).status, 404);
    assert.equal((await http('GET', `/api/v1/jobs/${job1Id}`, { cookie: rahbarACookie })).status, 200);
    assert.equal((await http('GET', `/api/v1/jobs/${job1Id}`, { cookie: sifatCookie })).status, 200);
    assert.equal((await http('GET', `/api/v1/jobs/${job1Id}`)).status, 401);
  });

  // 13. Unauthorized mutations
  await test('unauthorized job mutations are rejected and change nothing', async () => {
    assert.equal(
      (await http('POST', `/api/v1/jobs/${job1Id}/start`, { cookie: ustaBCookie })).status,
      404,
      'cross-branch start must 404',
    );
    assert.equal(
      (await http('POST', `/api/v1/jobs/${job1Id}/start`, { cookie: rahbarACookie })).status,
      403,
      'rahbar has no jobs.create',
    );
    assert.equal(
      (await http('POST', `/api/v1/jobs/${job1Id}/cancel`, { cookie: sifatCookie, body: { reason: 'test' } })).status,
      403,
    );
    const row = await db('jobs').where({ id: job1Id }).first();
    assert.equal(row.status, 'DRAFT', 'status must be untouched');
  });

  // 14. Start transition
  await test('same-branch MASTER starts the job: IN_PROGRESS, started_at, audited', async () => {
    const res = await http('POST', `/api/v1/jobs/${job1Id}/start`, { cookie: masterACookie });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.job.status, 'IN_PROGRESS');

    const row = await db('jobs').where({ id: job1Id }).first();
    assert.equal(row.status, 'IN_PROGRESS');
    assert.ok(row.started_at, 'started_at must be set');

    const audit = await db('audit_logs')
      .where({ action: 'JOB_STARTED', entity_type: 'job', entity_id: String(job1Id) })
      .first();
    assert.ok(audit, 'JOB_STARTED audit row must exist');
    assert.equal(audit.user_id, fx.ids.masterA);
  });

  // 15. Invalid transitions
  await test('invalid status transitions are rejected (409)', async () => {
    const again = await http('POST', `/api/v1/jobs/${job1Id}/start`, { cookie: ustaACookie });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'INVALID_TRANSITION');
  });

  // 16. Arbitrary status manipulation impossible
  await test('no generic status manipulation surface exists', async () => {
    assert.equal(
      (await http('PATCH', `/api/v1/jobs/${job1Id}`, { cookie: ustaACookie, body: { status: 'COMPLETED' } })).status,
      404,
      'there must be no PATCH /jobs/:id route',
    );
    const row = await db('jobs').where({ id: job1Id }).first();
    assert.equal(row.status, 'IN_PROGRESS');
  });

  // 17. Cancel transition
  await test('cancel requires a reason and is audited; works from IN_PROGRESS', async () => {
    const noReason = await http('POST', `/api/v1/jobs/${job1Id}/cancel`, { cookie: ustaACookie, body: { reason: '' } });
    assert.equal(noReason.status, 422, 'cancellation reason must be mandatory');

    const res = await http('POST', `/api/v1/jobs/${job1Id}/cancel`, {
      cookie: ustaACookie,
      body: { reason: 'Mijoz xizmatdan voz kechdi' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.job.status, 'CANCELLED');
    assert.equal(res.body.job.cancelReason, 'Mijoz xizmatdan voz kechdi');
    assert.equal(res.body.job.cancelledByName, 'Job UstaA');

    const audit = await db('audit_logs')
      .where({ action: 'JOB_CANCELLED', entity_type: 'job', entity_id: String(job1Id) })
      .first();
    assert.ok(audit, 'JOB_CANCELLED audit row must exist');
    const oldVal = typeof audit.old_value === 'string' ? JSON.parse(audit.old_value) : audit.old_value;
    assert.equal(oldVal.status, 'IN_PROGRESS');

    const startCancelled = await http('POST', `/api/v1/jobs/${job1Id}/start`, { cookie: ustaACookie });
    assert.equal(startCancelled.status, 409, 'a cancelled job cannot be started');
  });

  // 18. Later-phase statuses are locked
  await test('later-phase statuses cannot be entered or left through Phase 4 endpoints', async () => {
    await db('jobs').where({ id: masterJobId }).update({ status: 'COMPLETED' });
    assert.equal(
      (await http('POST', `/api/v1/jobs/${masterJobId}/cancel`, { cookie: masterACookie, body: { reason: 'test' } }))
        .status,
      409,
      'a COMPLETED job cannot be cancelled in Phase 4',
    );
    assert.equal((await http('POST', `/api/v1/jobs/${masterJobId}/start`, { cookie: masterACookie })).status, 409);
    await db('jobs').where({ id: masterJobId }).update({ status: 'DRAFT' });
  });

  // 19. No deletion
  await test('jobs cannot be deleted; referenced records are delete-protected', async () => {
    assert.equal((await http('DELETE', `/api/v1/jobs/${job1Id}`, { cookie: adminCookie })).status, 404);
    await assert.rejects(db('vehicles').where({ id: vehicle1Id }).del(), /foreign key constraint/i);
    await assert.rejects(db('customers').where({ id: customer1Id }).del(), /foreign key constraint/i);
    const hasDeletedAt = await db.schema.hasColumn('jobs', 'deleted_at');
    assert.equal(hasDeletedAt, false, 'jobs must not even have a soft-delete column');
  });

  // 20. No duplication of customers/vehicles
  await test('job creation does not duplicate customer or vehicle records', async () => {
    const customerCountAfter = Number(((await db('customers').count({ c: '*' })) as any)[0].c);
    const vehicleCountAfter = Number(((await db('vehicles').count({ c: '*' })) as any)[0].c);
    assert.equal(customerCountAfter, customerCountBefore);
    assert.equal(vehicleCountAfter, vehicleCountBefore);
  });

  // 21. Relationships intact
  await test('customer↔vehicle↔job relationships remain consistent', async () => {
    const vehicle = await db('vehicles').where({ id: vehicle1Id }).first();
    assert.equal(vehicle.customer_id, customer1Id, 'vehicle still belongs to its customer');
    const job = await db('jobs').where({ id: job1Id }).first();
    assert.equal(job.customer_id, customer1Id);
    assert.equal(job.vehicle_id, vehicle1Id);
  });

  // 22. Malformed IDs
  await test('malformed IDs and payloads are rejected (422)', async () => {
    assert.equal((await http('GET', '/api/v1/jobs/abc', { cookie: ustaACookie })).status, 422);
    assert.equal(
      (await http('POST', '/api/v1/jobs', { cookie: ustaACookie, body: { customerId: 'x', vehicleId: [] } })).status,
      422,
    );
    assert.equal((await http('GET', '/api/v1/jobs?status=NOTREAL', { cookie: ustaACookie })).status, 422);
  });

  // 23. Pagination
  await test('pagination works with correct totals and no overlap', async () => {
    const rows = Array.from({ length: 30 }, () => ({
      customer_id: customer1Id,
      vehicle_id: vehicle1Id,
      branch_id: fx.branchA,
      created_by: fx.ids.ustaA,
      status: 'DRAFT',
    }));
    await db('jobs').insert(rows);

    const page1 = await http('GET', '/api/v1/jobs?limit=25&page=1', { cookie: ustaACookie });
    assert.equal(page1.status, 200);
    assert.ok(page1.body.total >= 32, `expected >= 32 branch-A jobs, got ${page1.body.total}`);
    assert.equal(page1.body.jobs.length, 25);

    const page2 = await http('GET', '/api/v1/jobs?limit=25&page=2', { cookie: ustaACookie });
    assert.ok(page2.body.jobs.length >= 7);
    const ids1 = new Set(page1.body.jobs.map((j: any) => j.id));
    assert.ok(page2.body.jobs.every((j: any) => !ids1.has(j.id)), 'pages must not overlap');
  });

  // 24. Audit completeness
  await test('all Phase 4 audit actions exist with correct actors', async () => {
    for (const [action, actorId] of [
      ['JOB_CREATED', fx.ids.ustaA],
      ['JOB_STARTED', fx.ids.masterA],
      ['JOB_CANCELLED', fx.ids.ustaA],
    ] as const) {
      const row = await db('audit_logs').where({ action, user_id: actorId }).first();
      assert.ok(row, `missing audit action ${action} by actor ${actorId}`);
    }
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
