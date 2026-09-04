/**
 * EASY GAS — Phase 5 checklist foundation end-to-end tests.
 *
 * Runs the Express app in-process against the real MySQL dev database
 * (migrations + seeds must be applied first).
 *
 *   npm run test:checklist
 *
 * Fixtures: users +99899000950x, branches/customers "TEST CL ...", plates TCL*,
 * templates "TEST CL ...". Cleaned up before and after the run.
 */
import { assertTestDatabase } from './helpers/test-env'; // MUST be first: NODE_ENV=test + *_test DB
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import { db } from '../src/config/database';
import { createApp } from '../src/app';
import { csrfTokenFor } from '../src/middleware/csrf.middleware';
import { setSmsProviderForTesting } from '../src/sms';

const USERS = {
  admin: '+998990009501',
  ustaA: '+998990009502',
  masterA: '+998990009503',
  ustaB: '+998990009504',
  sifat: '+998990009505',
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
    headers: {
      'content-type': 'application/json',
      ...(opts.cookie ? { cookie: opts.cookie, 'x-csrf-token': csrfTokenFor(opts.cookie.split('=')[1] ?? '') } : {}),
    },
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
  // Execution data for test jobs (vehicles TCL*)
  const jobIds = (
    await db('jobs')
      .join('vehicles', 'vehicles.id', 'jobs.vehicle_id')
      .where('vehicles.plate_number', 'like', 'TCL%')
      .select('jobs.id')
  ).map((j: { id: number }) => j.id);
  if (jobIds.length > 0) {
    // Phase 6: STOP submissions create stop_approvals rows referencing job_steps.
    const approvalIds = (await db('stop_approvals').whereIn('job_id', jobIds).select('id')).map((a: { id: number }) => a.id);
    if (approvalIds.length > 0) {
      await db('audit_logs').where('entity_type', 'stop_approval').whereIn('entity_id', approvalIds.map(String)).del();
    }
    await db('stop_approvals').whereIn('job_id', jobIds).del();
    const checklistIds = (await db('job_checklists').whereIn('job_id', jobIds).select('id')).map((c: { id: number }) => c.id);
    if (checklistIds.length > 0) {
      const jobStepIds = (await db('job_steps').whereIn('job_checklist_id', checklistIds).select('id')).map(
        (s: { id: number }) => s.id,
      );
      if (jobStepIds.length > 0) {
        await db('step_measurements').whereIn('job_step_id', jobStepIds).del();
        await db('audit_logs').where('entity_type', 'job_step').whereIn('entity_id', jobStepIds.map(String)).del();
        await db('job_steps').whereIn('id', jobStepIds).del();
      }
      await db('job_checklists').whereIn('id', checklistIds).del();
    }
    await db('audit_logs').where('entity_type', 'job').whereIn('entity_id', jobIds.map(String)).del();
    await db('jobs').whereIn('id', jobIds).del();
  }

  // Template structures ("TEST CL ..." templates)
  const templateIds = (await db('checklist_templates').where('name', 'like', 'TEST CL%').select('id')).map(
    (t: { id: number }) => t.id,
  );
  if (templateIds.length > 0) {
    const versionIds = (await db('checklist_template_versions').whereIn('template_id', templateIds).select('id')).map(
      (v: { id: number }) => v.id,
    );
    if (versionIds.length > 0) {
      const stepIds = (await db('checklist_steps').whereIn('version_id', versionIds).select('id')).map(
        (s: { id: number }) => s.id,
      );
      if (stepIds.length > 0) {
        await db('checklist_step_measurements').whereIn('step_id', stepIds).del();
        await db('checklist_steps').whereIn('id', stepIds).del();
      }
      await db('audit_logs')
        .where('entity_type', 'checklist_template_version')
        .whereIn('entity_id', versionIds.map(String))
        .del();
      await db('checklist_template_versions').whereIn('id', versionIds).del();
    }
    await db('audit_logs')
      .where('entity_type', 'checklist_template')
      .whereIn('entity_id', templateIds.map(String))
      .del();
    await db('checklist_templates').whereIn('id', templateIds).del();
  }

  const customerIds = (await db('customers').where('name', 'like', 'TEST CL%').select('id')).map(
    (c: { id: number }) => c.id,
  );
  await db('vehicles').where('plate_number', 'like', 'TCL%').del();
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
  await db('branches').where('name', 'like', 'TEST CL%').del();
}

interface Fixtures {
  branchA: number;
  branchB: number;
  ids: Record<string, number>;
}

async function createFixtures(): Promise<Fixtures> {
  const roles = await db('roles').select('id', 'code');
  const roleId = (code: string) => roles.find((r: { code: string }) => r.code === code)?.id;

  const [branchA] = await db('branches').insert({ name: 'TEST CL Branch A', region: 'Toshkent shahri', status: 'ACTIVE' });
  const [branchB] = await db('branches').insert({ name: 'TEST CL Branch B', region: 'Samarqand', status: 'ACTIVE' });

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const base = { password_hash: passwordHash, region: 'Toshkent shahri', status: 'ACTIVE' };
  const insert = async (row: Record<string, unknown>) => {
    const [id] = await db('users').insert(row);
    return id as number;
  };

  const ids: Record<string, number> = {};
  ids.admin = await insert({ ...base, first_name: 'Cl', last_name: 'Admin', phone: USERS.admin, branch_id: null, role_id: roleId('ADMIN') });
  ids.ustaA = await insert({ ...base, first_name: 'Cl', last_name: 'UstaA', phone: USERS.ustaA, branch_id: branchA, role_id: roleId('USTA') });
  ids.masterA = await insert({ ...base, first_name: 'Cl', last_name: 'MasterA', phone: USERS.masterA, branch_id: branchA, role_id: roleId('MASTER') });
  ids.ustaB = await insert({ ...base, first_name: 'Cl', last_name: 'UstaB', phone: USERS.ustaB, branch_id: branchB, role_id: roleId('USTA') });
  ids.sifat = await insert({ ...base, first_name: 'Cl', last_name: 'Sifat', phone: USERS.sifat, branch_id: null, role_id: roleId('SIFAT') });

  return { branchA: branchA as number, branchB: branchB as number, ids };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  setSmsProviderForTesting({ name: 'test-capture', send: async () => ({ providerMessageId: null, outcome: 'ACCEPTED' as const }) });
  await assertTestDatabase(db);
  await cleanup();
  const fx = await createFixtures();

  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;

  console.log(`\nRunning checklist E2E against ${baseUrl}\n`);

  const adminCookie = await login(USERS.admin);
  const ustaACookie = await login(USERS.ustaA);
  const masterACookie = await login(USERS.masterA);
  const ustaBCookie = await login(USERS.ustaB);
  const sifatCookie = await login(USERS.sifat);

  // --- Business fixtures through the real API ---
  const c = await http('POST', '/api/v1/customers', {
    cookie: ustaACookie,
    body: { name: 'TEST CL Mijoz', phone: '99 000 95 11' },
  });
  assert.equal(c.status, 201);
  const customerId = c.body.customer.id as number;

  const mkVehicle = async (plate: string) => {
    const v = await http('POST', '/api/v1/vehicles', {
      cookie: ustaACookie,
      body: { customerId, plateNumber: plate, make: 'Chevrolet', model: 'Cobalt' },
    });
    assert.equal(v.status, 201);
    return v.body.vehicle.id as number;
  };
  const vehicle1 = await mkVehicle('TCL001AA');
  const vehicle2 = await mkVehicle('TCL002BB');
  const vehicle3 = await mkVehicle('TCL003CC');
  const vehicle4 = await mkVehicle('TCL004DD');

  const mkJob = async (vehicleId: number) => {
    const j = await http('POST', '/api/v1/jobs', { cookie: ustaACookie, body: { customerId, vehicleId } });
    assert.equal(j.status, 201);
    return j.body.job.id as number;
  };
  const jobV1 = await mkJob(vehicle1); // historical-integrity job (stays on v1)
  const jobMain = await mkJob(vehicle2); // sequential execution job (v2)
  const jobMeasure = await mkJob(vehicle3); // measurement boundary job
  const jobConc = await mkJob(vehicle4); // concurrency job

  for (const id of [jobV1, jobMain, jobMeasure, jobConc]) {
    assert.equal((await http('POST', `/api/v1/jobs/${id}/start`, { cookie: ustaACookie })).status, 200);
  }

  let t1Id = 0;
  let t1v1Id = 0;
  let t1v2Id = 0;

  // ---------------- TEMPLATES ----------------

  // 1. Create template
  await test('admin creates a template (v1 draft auto-created, audited)', async () => {
    const res = await http('POST', '/api/v1/checklist-templates', {
      cookie: adminCookie,
      body: { name: "TEST CL Gaz o'rnatish", description: 'Asosiy tekshiruv' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    t1Id = res.body.template.id;
    assert.equal(res.body.template.versions.length, 1);
    assert.equal(res.body.template.versions[0].version, 1);
    assert.equal(res.body.template.versions[0].status, 'DRAFT');
    t1v1Id = res.body.template.versions[0].id;

    const audit = await db('audit_logs')
      .where({ action: 'TEMPLATE_CREATED', entity_type: 'checklist_template', entity_id: String(t1Id) })
      .first();
    assert.ok(audit && audit.user_id === fx.ids.admin);
  });

  // 2. Unauthorized template management
  await test('non-admin roles cannot manage or list templates', async () => {
    for (const cookie of [ustaACookie, masterACookie, sifatCookie]) {
      assert.equal((await http('GET', '/api/v1/checklist-templates', { cookie })).status, 403);
      assert.equal(
        (await http('POST', '/api/v1/checklist-templates', { cookie, body: { name: 'TEST CL Hack' } })).status,
        403,
      );
      assert.equal(
        (await http('POST', `/api/v1/checklist-templates/${t1Id}/versions/${t1v1Id}/publish`, { cookie })).status,
        403,
      );
    }
    assert.equal((await http('GET', '/api/v1/checklist-templates')).status, 401);
    assert.equal(await db('checklist_templates').where({ name: 'TEST CL Hack' }).first(), undefined);
  });

  // 3-4. Steps with measurements
  await test('admin adds ordered steps with measurement definitions', async () => {
    const s1 = await http('POST', `/api/v1/checklist-templates/${t1Id}/versions/${t1v1Id}/steps`, {
      cookie: adminCookie,
      body: { name: 'Tayyorgarlik tekshiruvi', description: 'Dastlabki holat' },
    });
    assert.equal(s1.status, 201);

    const s2 = await http('POST', `/api/v1/checklist-templates/${t1Id}/versions/${t1v1Id}/steps`, {
      cookie: adminCookie,
      body: {
        name: 'Reduktor sozlash',
        requirements: 'Ish bosimi normada',
        measurements: [
          { name: 'Ish bosimi', unit: 'bar', minValue: 0.9, maxValue: 1.4, expectedValue: 1.2, required: true },
          { name: 'Sovutish harorati', unit: '°C', maxValue: 110, required: false },
        ],
      },
    });
    assert.equal(s2.status, 201);

    const s3 = await http('POST', `/api/v1/checklist-templates/${t1Id}/versions/${t1v1Id}/steps`, {
      cookie: adminCookie,
      body: { name: 'Yakuniy tekshiruv', isStop: true, riskWeight: 50 },
    });
    assert.equal(s3.status, 201);

    const v1 = s3.body.template.versions.find((v: any) => v.id === t1v1Id);
    assert.deepEqual(
      v1.steps.map((s: any) => [s.sortOrder, s.name]),
      [
        [1, 'Tayyorgarlik tekshiruvi'],
        [2, 'Reduktor sozlash'],
        [3, 'Yakuniy tekshiruv'],
      ],
    );
    assert.equal(v1.steps[1].measurements.length, 2);
    assert.equal(v1.steps[1].measurements[0].minValue, 0.9);
    assert.equal(v1.steps[2].isStop, true);
  });

  // 5. Ordering: move + delete renormalizes
  await test('step reordering and draft deletion keep deterministic order', async () => {
    const add = await http('POST', `/api/v1/checklist-templates/${t1Id}/versions/${t1v1Id}/steps`, {
      cookie: adminCookie,
      body: { name: 'Vaqtinchalik bosqich' },
    });
    assert.equal(add.status, 201);
    const v1 = add.body.template.versions.find((v: any) => v.id === t1v1Id);
    const tempStep = v1.steps.find((s: any) => s.name === 'Vaqtinchalik bosqich');
    assert.equal(tempStep.sortOrder, 4);

    const moved = await http(
      'POST',
      `/api/v1/checklist-templates/${t1Id}/versions/${t1v1Id}/steps/${tempStep.id}/move`,
      { cookie: adminCookie, body: { direction: 'up' } },
    );
    const vAfterMove = moved.body.template.versions.find((v: any) => v.id === t1v1Id);
    assert.deepEqual(
      vAfterMove.steps.map((s: any) => s.name),
      ['Tayyorgarlik tekshiruvi', 'Reduktor sozlash', 'Vaqtinchalik bosqich', 'Yakuniy tekshiruv'],
    );

    const deleted = await http(
      'DELETE',
      `/api/v1/checklist-templates/${t1Id}/versions/${t1v1Id}/steps/${tempStep.id}`,
      { cookie: adminCookie },
    );
    const vAfterDelete = deleted.body.template.versions.find((v: any) => v.id === t1v1Id);
    assert.deepEqual(
      vAfterDelete.steps.map((s: any) => [s.sortOrder, s.name]),
      [
        [1, 'Tayyorgarlik tekshiruvi'],
        [2, 'Reduktor sozlash'],
        [3, 'Yakuniy tekshiruv'],
      ],
      'order must be renormalized to 1..N after deletion',
    );
  });

  // 6. Publishing
  await test('publishing works; empty versions cannot be published', async () => {
    const res = await http('POST', `/api/v1/checklist-templates/${t1Id}/versions/${t1v1Id}/publish`, {
      cookie: adminCookie,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const v1 = res.body.template.versions.find((v: any) => v.id === t1v1Id);
    assert.equal(v1.status, 'PUBLISHED');

    const audit = await db('audit_logs')
      .where({ action: 'TEMPLATE_VERSION_PUBLISHED', entity_id: String(t1v1Id) })
      .first();
    assert.ok(audit && audit.user_id === fx.ids.admin);

    const empty = await http('POST', '/api/v1/checklist-templates', {
      cookie: adminCookie,
      body: { name: "TEST CL O'lchov shabloni" },
    });
    const emptyVersionId = empty.body.template.versions[0].id;
    const publishEmpty = await http(
      'POST',
      `/api/v1/checklist-templates/${empty.body.template.id}/versions/${emptyVersionId}/publish`,
      { cookie: adminCookie },
    );
    assert.equal(publishEmpty.status, 409);
    assert.equal(publishEmpty.body.error.code, 'EMPTY_VERSION');
  });

  // 7. Published version immutability
  await test('published version cannot be modified (steps add/edit/delete/move)', async () => {
    const attempts = [
      http('POST', `/api/v1/checklist-templates/${t1Id}/versions/${t1v1Id}/steps`, {
        cookie: adminCookie,
        body: { name: 'Buzish urinishi' },
      }),
      http('PATCH', `/api/v1/checklist-templates/${t1Id}/versions/${t1v1Id}/steps/1`, {
        cookie: adminCookie,
        body: { name: "O'zgartirish urinishi", measurements: [] },
      }),
      http('DELETE', `/api/v1/checklist-templates/${t1Id}/versions/${t1v1Id}/steps/1`, { cookie: adminCookie }),
      http('POST', `/api/v1/checklist-templates/${t1Id}/versions/${t1v1Id}/steps/1/move`, {
        cookie: adminCookie,
        body: { direction: 'up' },
      }),
    ];
    for (const attempt of await Promise.all(attempts)) {
      assert.equal(attempt.status, 409, JSON.stringify(attempt.body));
      assert.equal(attempt.body.error.code, 'VERSION_NOT_DRAFT');
    }
  });

  // 10 (part). Assign v1 to the historical job BEFORE v2 exists
  let jobV1ChecklistVersion = 0;
  await test('checklist assignment snapshots the current published version', async () => {
    const res = await http('POST', `/api/v1/jobs/${jobV1}/checklist`, {
      cookie: ustaACookie,
      body: { templateId: t1Id },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.checklist.version, 1);
    assert.equal(res.body.checklist.progress.total, 3);
    jobV1ChecklistVersion = res.body.checklist.version;

    const audit = await db('audit_logs')
      .where({ action: 'CHECKLIST_ASSIGNED', entity_type: 'job', entity_id: String(jobV1) })
      .first();
    assert.ok(audit && audit.user_id === fx.ids.ustaA, 'assignment must be audited with actor');

    const dup = await http('POST', `/api/v1/jobs/${jobV1}/checklist`, { cookie: ustaACookie, body: { templateId: t1Id } });
    assert.equal(dup.status, 409, 'double assignment must be refused');
  });

  // 8-9. New version does not alter the old one; historical job keeps v1
  await test('v2 creation copies steps; publishing v2 archives v1 without altering it', async () => {
    const created = await http('POST', `/api/v1/checklist-templates/${t1Id}/versions`, { cookie: adminCookie });
    assert.equal(created.status, 201);
    const v2 = created.body.template.versions.find((v: any) => v.status === 'DRAFT');
    assert.equal(v2.version, 2);
    assert.equal(v2.steps.length, 3, 'steps must be copied from v1');
    assert.equal(v2.steps[1].measurements.length, 2, 'measurement definitions must be copied');
    t1v2Id = v2.id;

    const added = await http('POST', `/api/v1/checklist-templates/${t1Id}/versions/${t1v2Id}/steps`, {
      cookie: adminCookie,
      body: { name: "Qo'shimcha germetiklik testi" },
    });
    assert.equal(added.status, 201);

    const published = await http('POST', `/api/v1/checklist-templates/${t1Id}/versions/${t1v2Id}/publish`, {
      cookie: adminCookie,
    });
    assert.equal(published.status, 200);
    const versions = published.body.template.versions;
    assert.equal(versions.find((v: any) => v.id === t1v1Id).status, 'ARCHIVED', 'v1 must be auto-archived');
    assert.equal(versions.find((v: any) => v.id === t1v2Id).status, 'PUBLISHED');
    assert.equal(versions.find((v: any) => v.id === t1v1Id).steps.length, 3, 'v1 content must be unchanged');
    assert.equal(versions.find((v: any) => v.id === t1v2Id).steps.length, 4);
  });

  await test('historical job keeps its original version forever (§41)', async () => {
    const res = await http('GET', `/api/v1/jobs/${jobV1}/checklist`, { cookie: ustaACookie });
    assert.equal(res.status, 200);
    assert.equal(res.body.checklist.version, jobV1ChecklistVersion, 'must still be v1');
    assert.equal(res.body.checklist.progress.total, 3, 'must still have the v1 step count');

    const fresh = await http('POST', `/api/v1/jobs/${jobMain}/checklist`, {
      cookie: ustaACookie,
      body: { templateId: t1Id },
    });
    assert.equal(fresh.status, 201);
    assert.equal(fresh.body.checklist.version, 2, 'new assignments must use the new published version');
    assert.equal(fresh.body.checklist.progress.total, 4);
  });

  // 30. Client cannot choose an arbitrary version
  await test('client-sent version identifiers are ignored — server resolves the published version', async () => {
    const res = await http('POST', `/api/v1/jobs/${jobConc}/checklist`, {
      cookie: ustaACookie,
      body: { templateId: t1Id, versionId: t1v1Id, templateVersionId: t1v1Id },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.checklist.version, 2, 'archived v1 must not be assignable');
  });

  // ---------------- EXECUTION (jobMain, v2: 4 steps) ----------------

  let mainSteps: any[] = [];
  const reloadMain = async () => {
    const res = await http('GET', `/api/v1/jobs/${jobMain}/checklist`, { cookie: ustaACookie });
    assert.equal(res.status, 200);
    mainSteps = res.body.checklist.steps;
    return res.body.checklist;
  };

  // 11-13. Load + locking
  await test('checklist loads with ordered steps; only the first step is current', async () => {
    const checklist = await reloadMain();
    assert.equal(checklist.progress.completed, 0);
    assert.deepEqual(
      mainSteps.map((s: any) => s.sortOrder),
      [1, 2, 3, 4],
    );
    assert.equal(mainSteps[0].isCurrent, true);
    assert.ok(mainSteps.slice(1).every((s: any) => !s.isCurrent), 'later steps must be locked');
    assert.equal(checklist.currentStepId, mainSteps[0].id);
  });

  await test('a locked later step cannot be completed (sequence enforced server-side)', async () => {
    const res = await http('POST', `/api/v1/jobs/${jobMain}/checklist/steps/${mainSteps[2].id}/complete`, {
      cookie: ustaACookie,
      body: {},
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'PREVIOUS_STEP_INCOMPLETE');
  });

  // 14-15, 17-18. Complete current, unlock next, duplicate refused
  await test('current step completes, next unlocks, duplicate completion is refused', async () => {
    const res = await http('POST', `/api/v1/jobs/${jobMain}/checklist/steps/${mainSteps[0].id}/complete`, {
      cookie: ustaACookie,
      body: { note: 'Hammasi joyida' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.checklist.progress.completed, 1);
    assert.equal(res.body.checklist.steps[0].status, 'COMPLETED');
    assert.equal(res.body.checklist.steps[0].completedByName, 'Cl UstaA');
    assert.equal(res.body.checklist.steps[1].isCurrent, true, 'next step must become current');

    const dup = await http('POST', `/api/v1/jobs/${jobMain}/checklist/steps/${mainSteps[0].id}/complete`, {
      cookie: ustaACookie,
      body: {},
    });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'STEP_ALREADY_COMPLETED');

    const audit = await db('audit_logs')
      .where({ action: 'STEP_COMPLETED', entity_type: 'job_step', entity_id: String(mainSteps[0].id) })
      .first();
    assert.ok(audit && audit.user_id === fx.ids.ustaA, 'completion must be audited with actor');
  });

  // Measurement enforcement inside the sequence (step 2 has required "Ish bosimi" 0.9–1.4)
  await test('required measurement missing or out-of-range rejects completion; step stays PENDING', async () => {
    await reloadMain();
    const step2 = mainSteps[1];

    const missing = await http('POST', `/api/v1/jobs/${jobMain}/checklist/steps/${step2.id}/complete`, {
      cookie: ustaACookie,
      body: {},
    });
    assert.equal(missing.status, 422);

    const pressureId = step2.measurements.find((m: any) => m.name === 'Ish bosimi').id;
    const low = await http('POST', `/api/v1/jobs/${jobMain}/checklist/steps/${step2.id}/complete`, {
      cookie: ustaACookie,
      body: { measurements: [{ measurementId: pressureId, value: 0.5 }] },
    });
    assert.equal(low.status, 422);
    assert.equal(low.body.error.code, 'OUT_OF_RANGE');

    const row = await db('job_steps').where({ id: step2.id }).first();
    assert.equal(row.status, 'PENDING', 'rejected submission must not complete the step');
    assert.equal(await db('step_measurements').where({ job_step_id: step2.id }).first(), undefined);
  });

  await test('valid measurement completes the step; actual value stored separately from the rule', async () => {
    const step2 = mainSteps[1];
    const pressureId = step2.measurements.find((m: any) => m.name === 'Ish bosimi').id;
    const res = await http('POST', `/api/v1/jobs/${jobMain}/checklist/steps/${step2.id}/complete`, {
      cookie: masterACookie, // same-branch MASTER may execute too
      body: { measurements: [{ measurementId: pressureId, value: 1.2 }] },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const stored = await db('step_measurements').where({ job_step_id: step2.id, measurement_id: pressureId }).first();
    assert.equal(Number(stored.value), 1.2, 'stored value must equal the submitted value');
    assert.equal(Boolean(stored.is_within_range), true);
    // The template rule must remain untouched by execution:
    const rule = await db('checklist_step_measurements').where({ id: pressureId }).first();
    assert.equal(Number(rule.min_value), 0.9);
    assert.equal(Number(rule.max_value), 1.4);
  });

  // 19. Completion of the whole checklist (STOP steps now require Master approval — Phase 6)
  await test('completing every step (incl. Master-approved STOP) marks the checklist complete', async () => {
    await reloadMain();
    for (const step of mainSteps.filter((s: any) => !['COMPLETED', 'APPROVED'].includes(s.status))) {
      const res = await http('POST', `/api/v1/jobs/${jobMain}/checklist/steps/${step.id}/complete`, {
        cookie: ustaACookie,
        body: {},
      });
      assert.equal(res.status, 200, `step ${step.sortOrder}: ${JSON.stringify(res.body)}`);
      if (step.isStop) {
        // Since Phase 6 a STOP step waits for a Master decision before the job continues.
        const approve = await http('POST', `/api/v1/jobs/${jobMain}/stop/approve`, { cookie: masterACookie });
        assert.equal(approve.status, 200, `STOP approval for step ${step.sortOrder}: ${JSON.stringify(approve.body)}`);
      }
    }
    const checklist = await reloadMain();
    assert.equal(checklist.progress.completed, 4);
    assert.ok(checklist.completedAt, 'completed_at must be set');
    assert.equal(checklist.currentStepId, null);
  });

  // ---------------- MEASUREMENT BOUNDARIES (dedicated template, 3 steps min10/max20) ----------------

  let measureTemplateId = 0;
  await test('measurement boundary template prepared and assigned', async () => {
    const t = await http('GET', '/api/v1/checklist-templates', { cookie: adminCookie });
    const mt = t.body.templates.find((x: any) => x.name === "TEST CL O'lchov shabloni");
    measureTemplateId = mt.id;
    const draftId = mt.versions[0].id;
    for (const stepName of ['Min chegara', 'Max chegara', 'Oraliq qiymat']) {
      const res = await http('POST', `/api/v1/checklist-templates/${measureTemplateId}/versions/${draftId}/steps`, {
        cookie: adminCookie,
        body: {
          name: stepName,
          measurements: [{ name: 'Bosim', unit: 'bar', minValue: 10, maxValue: 20, required: true }],
        },
      });
      assert.equal(res.status, 201);
    }
    assert.equal(
      (await http('POST', `/api/v1/checklist-templates/${measureTemplateId}/versions/${draftId}/publish`, { cookie: adminCookie }))
        .status,
      200,
    );
    const assigned = await http('POST', `/api/v1/jobs/${jobMeasure}/checklist`, {
      cookie: ustaACookie,
      body: { templateId: measureTemplateId },
    });
    assert.equal(assigned.status, 201);
  });

  // 20-26. Inclusive boundaries + rejections + stored values
  await test('inclusive boundaries: min and max values are accepted; outside/invalid rejected', async () => {
    const load = async () =>
      (await http('GET', `/api/v1/jobs/${jobMeasure}/checklist`, { cookie: ustaACookie })).body.checklist;

    let checklist = await load();
    const submit = (stepIdx: number, value: unknown) =>
      http('POST', `/api/v1/jobs/${jobMeasure}/checklist/steps/${checklist.steps[stepIdx].id}/complete`, {
        cookie: ustaACookie,
        body: { measurements: [{ measurementId: checklist.steps[stepIdx].measurements[0].id, value }] },
      });

    // min boundary (10 → valid)
    assert.equal((await submit(0, 10)).status, 200, 'exact minimum must be accepted');
    // max boundary (20 → valid)
    checklist = await load();
    assert.equal((await submit(1, 20)).status, 200, 'exact maximum must be accepted');

    // third step: everything invalid first, then a valid mid value
    checklist = await load();
    const below = await submit(2, 9.999);
    assert.equal(below.status, 422, 'below minimum must be rejected');
    assert.equal(below.body.error.code, 'OUT_OF_RANGE');
    const above = await submit(2, 20.001);
    assert.equal(above.status, 422, 'above maximum must be rejected');
    const notNumber = await submit(2, 'abc');
    assert.equal(notNumber.status, 422, 'non-numeric must be rejected');
    const nan = await submit(2, null);
    assert.equal(nan.status, 422, 'null must be rejected');
    assert.equal((await submit(2, 15)).status, 200, 'mid-range value must be accepted');

    checklist = await load();
    assert.equal(checklist.progress.completed, 3);
    assert.ok(checklist.completedAt);

    // Stored values match exactly what was submitted
    const values = await db('step_measurements')
      .join('job_steps', 'job_steps.id', 'step_measurements.job_step_id')
      .join('job_checklists', 'job_checklists.id', 'job_steps.job_checklist_id')
      .where('job_checklists.job_id', jobMeasure)
      .orderBy('step_measurements.id')
      .pluck('step_measurements.value');
    assert.deepEqual(values.map(Number), [10, 20, 15]);
  });

  // ---------------- SECURITY ----------------

  await test('unauthorized checklist access and execution are rejected', async () => {
    assert.equal((await http('GET', `/api/v1/jobs/${jobMain}/checklist`)).status, 401);
    // SIFAT can VIEW any job checklist (services.view_all) but cannot execute
    assert.equal((await http('GET', `/api/v1/jobs/${jobMain}/checklist`, { cookie: sifatCookie })).status, 200);
    assert.equal(
      (await http('POST', `/api/v1/jobs/${jobV1}/checklist/steps/1/complete`, { cookie: sifatCookie, body: {} })).status,
      403,
    );
    assert.equal(
      (await http('POST', `/api/v1/jobs/${jobV1}/checklist`, { cookie: sifatCookie, body: { templateId: t1Id } })).status,
      403,
    );
  });

  await test('cross-branch checklist access is rejected via 404 (IDOR)', async () => {
    assert.equal((await http('GET', `/api/v1/jobs/${jobMain}/checklist`, { cookie: ustaBCookie })).status, 404);
    const v1Checklist = (await http('GET', `/api/v1/jobs/${jobV1}/checklist`, { cookie: ustaACookie })).body.checklist;
    assert.equal(
      (
        await http('POST', `/api/v1/jobs/${jobV1}/checklist/steps/${v1Checklist.steps[0].id}/complete`, {
          cookie: ustaBCookie,
          body: {},
        })
      ).status,
      404,
    );
    const row = await db('job_steps').where({ id: v1Checklist.steps[0].id }).first();
    assert.equal(row.status, 'PENDING', 'cross-branch attempt must not change anything');
  });

  await test('no surface exists to manipulate checklist or step status directly', async () => {
    assert.equal(
      (await http('PATCH', `/api/v1/jobs/${jobV1}/checklist`, { cookie: ustaACookie, body: { completedAt: 'now' } })).status,
      404,
    );
    assert.equal(
      (await http('PATCH', `/api/v1/jobs/${jobV1}/checklist/steps/1`, { cookie: ustaACookie, body: { status: 'COMPLETED' } }))
        .status,
      404,
    );
    assert.equal((await http('DELETE', `/api/v1/jobs/${jobV1}/checklist`, { cookie: ustaACookie })).status, 404);
  });

  await test('archived versions are as immutable as published ones', async () => {
    const res = await http('POST', `/api/v1/checklist-templates/${t1Id}/versions/${t1v1Id}/steps`, {
      cookie: adminCookie,
      body: { name: 'Arxivni buzish' },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'VERSION_NOT_DRAFT');
  });

  await test('checklist work is blocked when the job is not in a workable state', async () => {
    // completing a step on a DRAFT job
    const draftJob = await mkJob(vehicle1);
    const assigned = await http('POST', `/api/v1/jobs/${draftJob}/checklist`, {
      cookie: ustaACookie,
      body: { templateId: t1Id },
    });
    assert.equal(assigned.status, 201, 'assignment while DRAFT is allowed (preparation)');
    const complete = await http(
      'POST',
      `/api/v1/jobs/${draftJob}/checklist/steps/${assigned.body.checklist.steps[0].id}/complete`,
      { cookie: ustaACookie, body: {} },
    );
    assert.equal(complete.status, 409);
    assert.equal(complete.body.error.code, 'JOB_NOT_IN_PROGRESS');

    // assigning to a CANCELLED job
    const cancelledJob = await mkJob(vehicle1);
    await http('POST', `/api/v1/jobs/${cancelledJob}/cancel`, { cookie: ustaACookie, body: { reason: 'Test uchun' } });
    const assignCancelled = await http('POST', `/api/v1/jobs/${cancelledJob}/checklist`, {
      cookie: ustaACookie,
      body: { templateId: t1Id },
    });
    assert.equal(assignCancelled.status, 409);
    assert.equal(assignCancelled.body.error.code, 'JOB_STATE_INVALID');
  });

  await test('malformed IDs and payloads are rejected', async () => {
    assert.equal((await http('GET', '/api/v1/jobs/abc/checklist', { cookie: ustaACookie })).status, 422);
    assert.equal(
      (await http('POST', `/api/v1/jobs/${jobV1}/checklist/steps/abc/complete`, { cookie: ustaACookie, body: {} })).status,
      422,
    );
    assert.equal(
      (await http('POST', `/api/v1/jobs/${jobV1}/checklist`, { cookie: ustaACookie, body: { templateId: 'x' } })).status,
      422,
    );
    const badTemplate = await http('POST', `/api/v1/jobs/${jobV1}/checklist`, {
      cookie: ustaACookie,
      body: { templateId: 999999 },
    });
    // jobV1 already has a checklist → CHECKLIST_EXISTS fires first; use a fresh job for NO_PUBLISHED_VERSION
    assert.equal(badTemplate.status, 409);
    const freshJob = await mkJob(vehicle2);
    const noPublished = await http('POST', `/api/v1/jobs/${freshJob}/checklist`, {
      cookie: ustaACookie,
      body: { templateId: 999999 },
    });
    assert.equal(noPublished.status, 400);
    assert.equal(noPublished.body.error.code, 'NO_PUBLISHED_VERSION');
  });

  // ---------------- CONCURRENCY ----------------

  await test('concurrent completion of the same step: exactly one succeeds', async () => {
    const checklist = (await http('GET', `/api/v1/jobs/${jobConc}/checklist`, { cookie: ustaACookie })).body.checklist;
    const firstStepId = checklist.steps[0].id;

    const [a, b] = await Promise.all([
      http('POST', `/api/v1/jobs/${jobConc}/checklist/steps/${firstStepId}/complete`, {
        cookie: ustaACookie,
        body: { note: 'A' },
      }),
      http('POST', `/api/v1/jobs/${jobConc}/checklist/steps/${firstStepId}/complete`, {
        cookie: masterACookie,
        body: { note: 'B' },
      }),
    ]);

    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409], `expected one success and one conflict, got ${a.status}/${b.status}`);

    const row = await db('job_steps').where({ id: firstStepId }).first();
    assert.equal(row.status, 'COMPLETED');
    const auditCount = await db('audit_logs')
      .where({ action: 'STEP_COMPLETED', entity_type: 'job_step', entity_id: String(firstStepId) })
      .count({ c: '*' });
    assert.equal(Number((auditCount as any)[0].c), 1, 'exactly one completion may be recorded');
  });

  // ---------------- AUDIT COMPLETENESS ----------------

  await test('all Phase 5 audit actions exist with correct actors', async () => {
    for (const [action, actorId] of [
      ['TEMPLATE_CREATED', fx.ids.admin],
      ['TEMPLATE_VERSION_CREATED', fx.ids.admin],
      ['TEMPLATE_VERSION_PUBLISHED', fx.ids.admin],
      ['TEMPLATE_VERSION_ARCHIVED', fx.ids.admin],
      ['TEMPLATE_STEP_CHANGED', fx.ids.admin],
      ['CHECKLIST_ASSIGNED', fx.ids.ustaA],
      ['STEP_COMPLETED', fx.ids.ustaA],
      ['STEP_COMPLETED', fx.ids.masterA],
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
