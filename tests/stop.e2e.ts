/**
 * EASY GAS — Phase 6 STOP approval workflow end-to-end tests (§17–18).
 *
 * Runs the Express app in-process against the real MySQL dev database
 * (migrations + seeds must be applied first).
 *
 *   npm run test:stop
 *
 * Fixtures: users +99899000940x, branches/customers "TEST ST ...", plates TSP*,
 * template "TEST ST ...". Cleaned up before and after the run.
 */
import { assertTestDatabase } from './helpers/test-env'; // MUST be first: NODE_ENV=test + *_test DB
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import { db } from '../src/config/database';
import { createApp } from '../src/app';
import { csrfTokenFor } from '../src/middleware/csrf.middleware';
import { setSmsProviderForTesting } from '../src/sms';

const USERS = {
  admin: '+998990009401',
  ustaA: '+998990009402',
  masterA: '+998990009403',
  masterA2: '+998990009404',
  ustaB: '+998990009405',
  masterB: '+998990009406',
  sifat: '+998990009407',
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
  const jobIds = (
    await db('jobs')
      .join('vehicles', 'vehicles.id', 'jobs.vehicle_id')
      .where('vehicles.plate_number', 'like', 'TSP%')
      .select('jobs.id')
  ).map((j: { id: number }) => j.id);
  if (jobIds.length > 0) {
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
    await db('risk_events').whereIn('job_id', jobIds).del();
    await db('completion_snapshots').whereIn('job_id', jobIds).del();
    await db('job_assignments').whereIn('job_id', jobIds).del();
    await db('jobs').whereIn('id', jobIds).del();
  }

  const templateIds = (await db('checklist_templates').where('name', 'like', 'TEST ST%').select('id')).map(
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

  const customerIds = (await db('customers').where('name', 'like', 'TEST ST%').select('id')).map(
    (c: { id: number }) => c.id,
  );
  await db('vehicles').where('plate_number', 'like', 'TSP%').del();
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
  await db('branches').where('name', 'like', 'TEST ST%').del();
}

interface Fixtures {
  branchA: number;
  branchB: number;
  ids: Record<string, number>;
}

async function createFixtures(): Promise<Fixtures> {
  const roles = await db('roles').select('id', 'code');
  const roleId = (code: string) => roles.find((r: { code: string }) => r.code === code)?.id;

  const [branchA] = await db('branches').insert({ name: 'TEST ST Branch A', region: 'Toshkent shahri', status: 'ACTIVE' });
  const [branchB] = await db('branches').insert({ name: 'TEST ST Branch B', region: 'Samarqand', status: 'ACTIVE' });

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const base = { password_hash: passwordHash, region: 'Toshkent shahri', status: 'ACTIVE' };
  const insert = async (row: Record<string, unknown>) => {
    const [id] = await db('users').insert(row);
    return id as number;
  };

  const ids: Record<string, number> = {};
  ids.admin = await insert({ ...base, first_name: 'St', last_name: 'Admin', phone: USERS.admin, branch_id: null, role_id: roleId('ADMIN') });
  ids.ustaA = await insert({ ...base, first_name: 'St', last_name: 'UstaA', phone: USERS.ustaA, branch_id: branchA, role_id: roleId('USTA') });
  ids.masterA = await insert({ ...base, first_name: 'St', last_name: 'MasterA', phone: USERS.masterA, branch_id: branchA, role_id: roleId('MASTER') });
  ids.masterA2 = await insert({ ...base, first_name: 'St', last_name: 'MasterA2', phone: USERS.masterA2, branch_id: branchA, role_id: roleId('MASTER') });
  ids.ustaB = await insert({ ...base, first_name: 'St', last_name: 'UstaB', phone: USERS.ustaB, branch_id: branchB, role_id: roleId('USTA') });
  ids.masterB = await insert({ ...base, first_name: 'St', last_name: 'MasterB', phone: USERS.masterB, branch_id: branchB, role_id: roleId('MASTER') });
  ids.sifat = await insert({ ...base, first_name: 'St', last_name: 'Sifat', phone: USERS.sifat, branch_id: null, role_id: roleId('SIFAT') });

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

  console.log(`\nRunning STOP E2E against ${baseUrl}\n`);

  const adminCookie = await login(USERS.admin);
  const ustaACookie = await login(USERS.ustaA);
  const masterACookie = await login(USERS.masterA);
  const masterA2Cookie = await login(USERS.masterA2);
  const ustaBCookie = await login(USERS.ustaB);
  const masterBCookie = await login(USERS.masterB);
  const sifatCookie = await login(USERS.sifat);

  // --- Business fixtures via real API ---
  const c = await http('POST', '/api/v1/customers', {
    cookie: ustaACookie,
    body: { name: 'TEST ST Mijoz', phone: '99 000 94 11' },
  });
  const customerId = c.body.customer.id as number;

  const mkVehicle = async (plate: string) => {
    const v = await http('POST', '/api/v1/vehicles', {
      cookie: ustaACookie,
      body: { customerId, plateNumber: plate, make: 'Chevrolet', model: 'Lacetti' },
    });
    return v.body.vehicle.id as number;
  };
  const vehicleA = await mkVehicle('TSP001AA');
  const vehicleB = await mkVehicle('TSP002BB');
  const vehicleC = await mkVehicle('TSP003CC');
  const vehicleD = await mkVehicle('TSP004DD');

  // Template: s1 normal, s2 STOP (with required measurement), s3 normal
  const t = await http('POST', '/api/v1/checklist-templates', {
    cookie: adminCookie,
    body: { name: 'TEST ST Shablon' },
  });
  const templateId = t.body.template.id as number;
  const versionId = t.body.template.versions[0].id as number;
  for (const step of [
    { name: 'Tayyorgarlik', measurements: [] },
    {
      name: 'Reduktor STOP nazorati',
      isStop: true,
      riskWeight: 80,
      measurements: [{ name: 'Ish bosimi', unit: 'bar', minValue: 0.9, maxValue: 1.4, required: true }],
    },
    { name: 'Yakuniy montaj', measurements: [] },
  ]) {
    const res = await http('POST', `/api/v1/checklist-templates/${templateId}/versions/${versionId}/steps`, {
      cookie: adminCookie,
      body: step,
    });
    assert.equal(res.status, 201);
  }
  assert.equal(
    (await http('POST', `/api/v1/checklist-templates/${templateId}/versions/${versionId}/publish`, { cookie: adminCookie }))
      .status,
    200,
  );

  const mkStartedJobWithChecklist = async (vehicleId: number) => {
    const j = await http('POST', '/api/v1/jobs', { cookie: ustaACookie, body: { customerId, vehicleId } });
    const jobId = j.body.job.id as number;
    assert.equal((await http('POST', `/api/v1/jobs/${jobId}/start`, { cookie: ustaACookie })).status, 200);
    const a = await http('POST', `/api/v1/jobs/${jobId}/checklist`, { cookie: ustaACookie, body: { templateId } });
    assert.equal(a.status, 201);
    return { jobId, steps: a.body.checklist.steps as any[] };
  };

  const jobA = await mkStartedJobWithChecklist(vehicleA); // approve flow
  const jobB = await mkStartedJobWithChecklist(vehicleB); // reject flow
  const jobC = await mkStartedJobWithChecklist(vehicleC); // concurrency

  const complete = (jobId: number, stepId: number, cookie: string, body: any = {}) =>
    http('POST', `/api/v1/jobs/${jobId}/checklist/steps/${stepId}/complete`, { cookie, body });

  // 1. Normal steps unchanged
  await test('normal checklist steps still behave exactly as before', async () => {
    const res = await complete(jobA.jobId, jobA.steps[0].id, ustaACookie);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.checklist.steps[0].status, 'COMPLETED');
    const job = await db('jobs').where({ id: jobA.jobId }).first();
    assert.equal(job.status, 'IN_PROGRESS', 'normal completion must not change the job status');
    const audit = await db('audit_logs')
      .where({ action: 'STEP_COMPLETED', entity_type: 'job_step', entity_id: String(jobA.steps[0].id) })
      .first();
    assert.ok(audit, 'normal steps keep STEP_COMPLETED auditing');
  });

  // 2-3. STOP submission
  const pressureIdA = jobA.steps[1].measurements[0].id as number;
  await test('STOP submission: result stored, step WAITING_APPROVAL, job WAITING_STOP_APPROVAL, audited', async () => {
    const res = await complete(jobA.jobId, jobA.steps[1].id, ustaACookie, {
      note: 'Bosim normada',
      measurements: [{ measurementId: pressureIdA, value: 1.2 }],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const step = res.body.checklist.steps[1];
    assert.equal(step.status, 'WAITING_APPROVAL');
    assert.equal(step.stopApproval.status, 'PENDING');
    assert.equal(step.stopApproval.submittedByName, 'St UstaA');

    const jobRow = await db('jobs').where({ id: jobA.jobId }).first();
    assert.equal(jobRow.status, 'WAITING_STOP_APPROVAL');

    const approval = await db('stop_approvals').where({ job_id: jobA.jobId, status: 'PENDING' }).first();
    assert.ok(approval, 'PENDING stop_approvals record must exist');
    assert.equal(approval.submitted_by, fx.ids.ustaA);

    const value = await db('step_measurements').where({ job_step_id: jobA.steps[1].id }).first();
    assert.equal(Number(value.value), 1.2, 'the technician result must be stored');

    const audit = await db('audit_logs')
      .where({ action: 'STOP_SUBMITTED', entity_type: 'job_step', entity_id: String(jobA.steps[1].id) })
      .first();
    assert.ok(audit && audit.user_id === fx.ids.ustaA);
  });

  await test('while waiting: later steps and job transitions are blocked', async () => {
    const next = await complete(jobA.jobId, jobA.steps[2].id, ustaACookie);
    assert.equal(next.status, 409);
    assert.equal(next.body.error.code, 'JOB_NOT_IN_PROGRESS');
    assert.equal((await http('POST', `/api/v1/jobs/${jobA.jobId}/start`, { cookie: ustaACookie })).status, 409);
    const checklist = (await http('GET', `/api/v1/jobs/${jobA.jobId}/checklist`, { cookie: ustaACookie })).body.checklist;
    assert.equal(checklist.progress.completed, 1, 'WAITING_APPROVAL must not count as done');
  });

  // 4. Permission enforcement (§4: MASTER only — not USTA, not SIFAT, not ADMIN)
  await test('only MASTER may decide: USTA/SIFAT/ADMIN 403, unauthenticated 401', async () => {
    for (const cookie of [ustaACookie, sifatCookie, adminCookie]) {
      assert.equal((await http('POST', `/api/v1/jobs/${jobA.jobId}/stop/approve`, { cookie })).status, 403);
      assert.equal(
        (await http('POST', `/api/v1/jobs/${jobA.jobId}/stop/reject`, { cookie, body: { reason: 'test' } })).status,
        403,
      );
    }
    assert.equal((await http('POST', `/api/v1/jobs/${jobA.jobId}/stop/approve`)).status, 401);
    const jobRow = await db('jobs').where({ id: jobA.jobId }).first();
    assert.equal(jobRow.status, 'WAITING_STOP_APPROVAL', 'nothing may have changed');
  });

  // 5. Branch scope
  await test('cross-branch STOP access is rejected via 404 (IDOR)', async () => {
    assert.equal((await http('POST', `/api/v1/jobs/${jobA.jobId}/stop/approve`, { cookie: masterBCookie })).status, 404);
    assert.equal(
      (
        await http('POST', `/api/v1/jobs/${jobA.jobId}/stop/reject`, {
          cookie: masterBCookie,
          body: { reason: 'sinov sababi' },
        })
      ).status,
      404,
    );
    assert.equal((await http('GET', `/api/v1/jobs/${jobA.jobId}/stop`, { cookie: ustaBCookie })).status, 404);
  });

  // 6-7. Approve
  await test('MASTER approves: client-sent fields ignored, step APPROVED, job IN_PROGRESS, audited', async () => {
    const res = await http('POST', `/api/v1/jobs/${jobA.jobId}/stop/approve`, {
      cookie: masterACookie,
      body: { status: 'REJECTED', decidedBy: fx.ids.ustaA, approvedAt: '1999-01-01' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.checklist.steps[1].status, 'APPROVED');
    assert.equal(res.body.checklist.steps[1].stopApproval.decidedByName, 'St MasterA');

    const approval = await db('stop_approvals').where({ job_id: jobA.jobId }).first();
    assert.equal(approval.status, 'APPROVED', 'client-sent status must be ignored');
    assert.equal(approval.decided_by, fx.ids.masterA, 'decided_by is the authenticated actor, never client-supplied');
    assert.ok(approval.decided_at);

    const jobRow = await db('jobs').where({ id: jobA.jobId }).first();
    assert.equal(jobRow.status, 'IN_PROGRESS', 'approval returns the job to IN_PROGRESS');

    const audit = await db('audit_logs')
      .where({ action: 'STOP_APPROVED', entity_type: 'stop_approval', entity_id: String(approval.id) })
      .first();
    assert.ok(audit && audit.user_id === fx.ids.masterA);
  });

  // 8. Idempotency / after-decision
  await test('duplicate approve and reject-after-approve are refused', async () => {
    const again = await http('POST', `/api/v1/jobs/${jobA.jobId}/stop/approve`, { cookie: masterACookie });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'JOB_NOT_WAITING_STOP');
    const reject = await http('POST', `/api/v1/jobs/${jobA.jobId}/stop/reject`, {
      cookie: masterACookie,
      body: { reason: 'kech' },
    });
    assert.equal(reject.status, 409);
    const count = await db('stop_approvals').where({ job_id: jobA.jobId }).count({ c: '*' });
    assert.equal(Number((count as any)[0].c), 1, 'no second approval record may exist');
  });

  // 9. Workflow continues after approval
  await test('after approval the next step unlocks and the checklist can finish', async () => {
    const res = await complete(jobA.jobId, jobA.steps[2].id, ustaACookie);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.checklist.progress.completed, 3);
    assert.ok(res.body.checklist.completedAt, 'APPROVED STOP counts toward checklist completion');
  });

  // 10. History endpoint
  await test('STOP history is readable for authorized viewers', async () => {
    const res = await http('GET', `/api/v1/jobs/${jobA.jobId}/stop`, { cookie: sifatCookie });
    assert.equal(res.status, 200);
    assert.equal(res.body.approvals.length, 1);
    assert.equal(res.body.approvals[0].status, 'APPROVED');
    assert.equal(res.body.approvals[0].stepName, 'Reduktor STOP nazorati');
    assert.equal(res.body.approvals[0].submittedByName, 'St UstaA');
    assert.equal(res.body.approvals[0].decidedByName, 'St MasterA');
  });

  // 11-12. Reject flow
  const pressureIdB = jobB.steps[1].measurements[0].id as number;
  await test('rejection requires a non-blank reason', async () => {
    assert.equal((await complete(jobB.jobId, jobB.steps[0].id, ustaACookie)).status, 200);
    const submit = await complete(jobB.jobId, jobB.steps[1].id, ustaACookie, {
      measurements: [{ measurementId: pressureIdB, value: 1.0 }],
    });
    assert.equal(submit.status, 200);

    const noReason = await http('POST', `/api/v1/jobs/${jobB.jobId}/stop/reject`, { cookie: masterACookie, body: {} });
    assert.equal(noReason.status, 422);
    const blank = await http('POST', `/api/v1/jobs/${jobB.jobId}/stop/reject`, {
      cookie: masterACookie,
      body: { reason: '   ' },
    });
    assert.equal(blank.status, 422);
    const jobRow = await db('jobs').where({ id: jobB.jobId }).first();
    assert.equal(jobRow.status, 'WAITING_STOP_APPROVAL', 'invalid rejection must change nothing');
  });

  await test('valid rejection: reason persisted, step and job REJECTED, audited', async () => {
    const res = await http('POST', `/api/v1/jobs/${jobB.jobId}/stop/reject`, {
      cookie: masterACookie,
      body: { reason: 'Ish bosimi beqaror — qayta sozlash kerak' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.checklist.steps[1].status, 'REJECTED');
    assert.equal(res.body.checklist.steps[1].stopApproval.rejectReason, 'Ish bosimi beqaror — qayta sozlash kerak');

    const approval = await db('stop_approvals').where({ job_id: jobB.jobId }).first();
    assert.equal(approval.status, 'REJECTED');
    assert.equal(approval.reject_reason, 'Ish bosimi beqaror — qayta sozlash kerak');
    assert.equal(approval.decided_by, fx.ids.masterA);

    const jobRow = await db('jobs').where({ id: jobB.jobId }).first();
    assert.equal(jobRow.status, 'REJECTED');

    const audit = await db('audit_logs')
      .where({ action: 'STOP_REJECTED', entity_type: 'stop_approval', entity_id: String(approval.id) })
      .first();
    assert.ok(audit && audit.user_id === fx.ids.masterA);
  });

  // 13. Rejected job is blocked; technician result preserved
  await test('a rejected job cannot silently continue; the submitted result is preserved', async () => {
    assert.equal((await complete(jobB.jobId, jobB.steps[2].id, ustaACookie)).status, 409);
    assert.equal((await complete(jobB.jobId, jobB.steps[1].id, ustaACookie)).status, 409);
    assert.equal((await http('POST', `/api/v1/jobs/${jobB.jobId}/start`, { cookie: ustaACookie })).status, 409);
    assert.equal((await http('POST', `/api/v1/jobs/${jobB.jobId}/stop/approve`, { cookie: masterACookie })).status, 409);
    assert.equal(
      (await http('POST', `/api/v1/jobs/${jobB.jobId}/stop/reject`, { cookie: masterACookie, body: { reason: 'yana' } }))
        .status,
      409,
    );

    const value = await db('step_measurements').where({ job_step_id: jobB.steps[1].id }).first();
    assert.equal(Number(value.value), 1.0, 'the checklist result must remain after rejection');
    const stepRow = await db('job_steps').where({ id: jobB.steps[1].id }).first();
    assert.equal(stepRow.completed_by, fx.ids.ustaA, 'submission metadata must remain');
    const count = await db('stop_approvals').where({ job_id: jobB.jobId }).count({ c: '*' });
    assert.equal(Number((count as any)[0].c), 1, 'no additional decision records may appear');
  });

  // 14. Approval chain on wrong job states
  await test('approve/reject are refused for jobs not waiting for STOP (chain check)', async () => {
    const draft = await http('POST', '/api/v1/jobs', { cookie: ustaACookie, body: { customerId, vehicleId: vehicleD } });
    const draftJobId = draft.body.job.id;
    const onDraft = await http('POST', `/api/v1/jobs/${draftJobId}/stop/approve`, { cookie: masterACookie });
    assert.equal(onDraft.status, 409);
    assert.equal(onDraft.body.error.code, 'JOB_NOT_WAITING_STOP');

    await http('POST', `/api/v1/jobs/${draftJobId}/cancel`, { cookie: ustaACookie, body: { reason: 'Test' } });
    assert.equal((await http('POST', `/api/v1/jobs/${draftJobId}/stop/approve`, { cookie: masterACookie })).status, 409);
    assert.equal(
      (
        await http('POST', `/api/v1/jobs/${draftJobId}/stop/reject`, {
          cookie: masterACookie,
          body: { reason: 'sinov sababi' },
        })
      ).status,
      409,
    );
  });

  // 15. Immutability of STOP history
  await test('STOP history is immutable — no mutation surface exists', async () => {
    assert.equal(
      (await http('PATCH', `/api/v1/jobs/${jobB.jobId}/stop`, { cookie: masterACookie, body: { status: 'APPROVED' } }))
        .status,
      404,
    );
    assert.equal((await http('DELETE', `/api/v1/jobs/${jobB.jobId}/stop`, { cookie: masterACookie })).status, 404);
    const approval = await db('stop_approvals').where({ job_id: jobB.jobId }).first();
    assert.equal(approval.status, 'REJECTED', 'historical decision unchanged');
    assert.equal(approval.reject_reason, 'Ish bosimi beqaror — qayta sozlash kerak');
  });

  // 16. Concurrency — the critical test
  await test('two simultaneous decisions: exactly one succeeds, deterministic final state', async () => {
    assert.equal((await complete(jobC.jobId, jobC.steps[0].id, ustaACookie)).status, 200);
    const pressureIdC = jobC.steps[1].measurements[0].id as number;
    assert.equal(
      (
        await complete(jobC.jobId, jobC.steps[1].id, ustaACookie, {
          measurements: [{ measurementId: pressureIdC, value: 1.1 }],
        })
      ).status,
      200,
    );

    const [a, b] = await Promise.all([
      http('POST', `/api/v1/jobs/${jobC.jobId}/stop/approve`, { cookie: masterACookie }),
      http('POST', `/api/v1/jobs/${jobC.jobId}/stop/reject`, {
        cookie: masterA2Cookie,
        body: { reason: 'Qayta tekshirish kerak' },
      }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409], `got ${a.status}/${b.status}`);

    const approval = await db('stop_approvals').where({ job_id: jobC.jobId }).first();
    assert.ok(['APPROVED', 'REJECTED'].includes(approval.status), 'exactly one final decision');
    const jobRow = await db('jobs').where({ id: jobC.jobId }).first();
    assert.equal(
      jobRow.status,
      approval.status === 'APPROVED' ? 'IN_PROGRESS' : 'REJECTED',
      'job state must match the winning decision',
    );
    const decisionAudits = await db('audit_logs')
      .whereIn('action', ['STOP_APPROVED', 'STOP_REJECTED'])
      .where({ entity_type: 'stop_approval', entity_id: String(approval.id) })
      .count({ c: '*' });
    assert.equal(Number((decisionAudits as any)[0].c), 1, 'exactly one decision may be audited');
    const total = await db('stop_approvals').where({ job_id: jobC.jobId }).count({ c: '*' });
    assert.equal(Number((total as any)[0].c), 1, 'exactly one approval record');
  });

  // 17. Malformed input
  await test('malformed IDs and payloads are rejected', async () => {
    assert.equal((await http('POST', '/api/v1/jobs/abc/stop/approve', { cookie: masterACookie })).status, 422);
    assert.equal((await http('GET', '/api/v1/jobs/abc/stop', { cookie: masterACookie })).status, 422);
    assert.equal((await http('POST', '/api/v1/jobs/999999/stop/approve', { cookie: masterACookie })).status, 404);
  });

  // 18. Audit completeness
  await test('all STOP audit actions exist with correct actor attribution', async () => {
    for (const [action, actorId] of [
      ['STOP_SUBMITTED', fx.ids.ustaA],
      ['STOP_APPROVED', fx.ids.masterA],
      ['STOP_REJECTED', fx.ids.masterA],
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
