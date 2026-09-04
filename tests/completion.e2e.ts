/**
 * EASY GAS — Phase 8 completion flow E2E tests (§22–23).
 *
 * Runs the Express app in-process against real MySQL + real local storage
 * (migrations + seeds must be applied first).
 *
 *   npm run test:completion
 *
 * Fixtures: users +99899000910x, "TEST CM ..." names, TCM* plates.
 * Cleaned up (DB + storage) before and after the run.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { db } from '../src/config/database';
import { createApp } from '../src/app';
import { setSmsProviderForTesting } from '../src/sms';

const USERS = {
  admin: '+998990009101',
  ustaA: '+998990009102',
  masterA: '+998990009103',
  masterA2: '+998990009104',
  ustaB: '+998990009105',
  masterB: '+998990009106',
  sifat: '+998990009107',
};

const PASSWORD = 'Sinov-parol-123';
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const FAKE_IMAGE = Buffer.from('bu imzo emas, oddiy matn — magic bytes yo‘q!!');

let baseUrl = '';

interface HttpResult {
  status: number;
  body: any;
  setCookies: string[];
}

async function http(method: string, pathname: string, opts: { body?: unknown; cookie?: string } = {}): Promise<HttpResult> {
  const res = await fetch(`${baseUrl}${pathname}`, {
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

async function uploadFile(pathname: string, field: string, bytes: Buffer, cookie?: string): Promise<HttpResult> {
  const form = new FormData();
  form.append(field, new Blob([new Uint8Array(bytes)], { type: 'image/png' }), 'file.png');
  const res = await fetch(`${baseUrl}${pathname}`, { method: 'POST', headers: cookie ? { cookie } : {}, body: form });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, setCookies: [] };
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
// Fixtures / cleanup
// ---------------------------------------------------------------------------

async function cleanup(): Promise<void> {
  const jobIds = (
    await db('jobs')
      .join('vehicles', 'vehicles.id', 'jobs.vehicle_id')
      .where('vehicles.plate_number', 'like', 'TCM%')
      .select('jobs.id')
  ).map((j: { id: number }) => j.id);
  if (jobIds.length > 0) {
    await db('customer_signatures').whereIn('job_id', jobIds).del();
    for (const jobId of jobIds) {
      await fs.rm(path.resolve('./uploads/signatures', String(jobId)), { recursive: true, force: true });
      await fs.rm(path.resolve('./uploads/photos', String(jobId)), { recursive: true, force: true });
    }
    const photoIds = (await db('job_photos').whereIn('job_id', jobIds).select('id')).map((p: { id: number }) => p.id);
    if (photoIds.length > 0) {
      await db('audit_logs').where('entity_type', 'job_photo').whereIn('entity_id', photoIds.map(String)).del();
    }
    await db('job_photos').whereIn('job_id', jobIds).del();
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

  const templateIds = (await db('checklist_templates').where('name', 'like', 'TEST CM%').select('id')).map(
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

  const customerIds = (await db('customers').where('name', 'like', 'TEST CM%').select('id')).map(
    (c: { id: number }) => c.id,
  );
  await db('vehicles').where('plate_number', 'like', 'TCM%').del();
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
  await db('branches').where('name', 'like', 'TEST CM%').del();
}

async function createFixtures() {
  const roles = await db('roles').select('id', 'code');
  const roleId = (code: string) => roles.find((r: { code: string }) => r.code === code)?.id;
  const [branchA] = await db('branches').insert({ name: 'TEST CM Branch A', region: 'Toshkent shahri', status: 'ACTIVE' });
  const [branchB] = await db('branches').insert({ name: 'TEST CM Branch B', region: 'Samarqand', status: 'ACTIVE' });

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const base = { password_hash: passwordHash, region: 'Toshkent shahri', status: 'ACTIVE' };
  const insert = async (row: Record<string, unknown>) => {
    const [id] = await db('users').insert(row);
    return id as number;
  };

  const ids: Record<string, number> = {};
  ids.admin = await insert({ ...base, first_name: 'Cm', last_name: 'Admin', phone: USERS.admin, branch_id: null, role_id: roleId('ADMIN') });
  ids.ustaA = await insert({ ...base, first_name: 'Cm', last_name: 'UstaA', phone: USERS.ustaA, branch_id: branchA, role_id: roleId('USTA') });
  ids.masterA = await insert({ ...base, first_name: 'Cm', last_name: 'MasterA', phone: USERS.masterA, branch_id: branchA, role_id: roleId('MASTER') });
  ids.masterA2 = await insert({ ...base, first_name: 'Cm', last_name: 'MasterA2', phone: USERS.masterA2, branch_id: branchA, role_id: roleId('MASTER') });
  ids.ustaB = await insert({ ...base, first_name: 'Cm', last_name: 'UstaB', phone: USERS.ustaB, branch_id: branchB, role_id: roleId('USTA') });
  ids.masterB = await insert({ ...base, first_name: 'Cm', last_name: 'MasterB', phone: USERS.masterB, branch_id: branchB, role_id: roleId('MASTER') });
  ids.sifat = await insert({ ...base, first_name: 'Cm', last_name: 'Sifat', phone: USERS.sifat, branch_id: null, role_id: roleId('SIFAT') });

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

  console.log(`\nRunning completion E2E against ${baseUrl}\n`);

  const adminCookie = await login(USERS.admin);
  const ustaACookie = await login(USERS.ustaA);
  const masterACookie = await login(USERS.masterA);
  const masterA2Cookie = await login(USERS.masterA2);
  const ustaBCookie = await login(USERS.ustaB);
  const masterBCookie = await login(USERS.masterB);
  const sifatCookie = await login(USERS.sifat);

  const c = await http('POST', '/api/v1/customers', {
    cookie: ustaACookie,
    body: { name: 'TEST CM Mijoz', phone: '99 000 91 11' },
  });
  const customerId = c.body.customer.id as number;
  const mkVehicle = async (plate: string) =>
    (await http('POST', '/api/v1/vehicles', { cookie: ustaACookie, body: { customerId, plateNumber: plate, make: 'Chevrolet', model: 'Onix' } }))
      .body.vehicle.id as number;

  // Template: s1 plain · s2 measurement(10–20)+1 photo · s3 STOP + 1 photo
  const t = await http('POST', '/api/v1/checklist-templates', { cookie: adminCookie, body: { name: 'TEST CM Shablon' } });
  const templateId = t.body.template.id as number;
  const versionId = t.body.template.versions[0].id as number;
  for (const step of [
    { name: 'Tayyorgarlik' },
    { name: "O'lchov bosqichi", requiredPhotos: 1, measurements: [{ name: 'Bosim', unit: 'bar', minValue: 10, maxValue: 20, required: true }] },
    { name: 'Yakuniy STOP', isStop: true, requiredPhotos: 1 },
  ]) {
    assert.equal(
      (await http('POST', `/api/v1/checklist-templates/${templateId}/versions/${versionId}/steps`, { cookie: adminCookie, body: step })).status,
      201,
    );
  }
  assert.equal(
    (await http('POST', `/api/v1/checklist-templates/${templateId}/versions/${versionId}/publish`, { cookie: adminCookie })).status,
    200,
  );

  const photosPath = (jobId: number, stepId: number) => `/api/v1/jobs/${jobId}/checklist/steps/${stepId}/photos`;
  const complete = (jobId: number, stepId: number, body: any = {}) =>
    http('POST', `/api/v1/jobs/${jobId}/checklist/steps/${stepId}/complete`, { cookie: ustaACookie, body });

  const mkJob = async (plate: string, opts: { start?: boolean; checklist?: boolean } = { start: true, checklist: true }) => {
    const vehicleId = await mkVehicle(plate);
    const j = await http('POST', '/api/v1/jobs', { cookie: ustaACookie, body: { customerId, vehicleId } });
    const jobId = j.body.job.id as number;
    if (opts.start !== false) await http('POST', `/api/v1/jobs/${jobId}/start`, { cookie: ustaACookie });
    let steps: any[] = [];
    if (opts.checklist !== false) {
      const a = await http('POST', `/api/v1/jobs/${jobId}/checklist`, { cookie: ustaACookie, body: { templateId } });
      steps = a.body.checklist.steps;
    }
    return { jobId, steps };
  };

  /** Walks a job to "checklist fully done + STOP approved" (ready except signature). */
  const prepareReady = async (plate: string) => {
    const job = await mkJob(plate);
    assert.equal((await complete(job.jobId, job.steps[0].id)).status, 200);
    assert.equal((await uploadFile(photosPath(job.jobId, job.steps[1].id), 'photo', PNG_BYTES, ustaACookie)).status, 201);
    const measurementId = job.steps[1].measurements[0].id;
    assert.equal((await complete(job.jobId, job.steps[1].id, { measurements: [{ measurementId, value: 15 }] })).status, 200);
    assert.equal((await uploadFile(photosPath(job.jobId, job.steps[2].id), 'photo', PNG_BYTES, ustaACookie)).status, 201);
    assert.equal((await complete(job.jobId, job.steps[2].id)).status, 200);
    assert.equal((await http('POST', `/api/v1/jobs/${job.jobId}/stop/approve`, { cookie: masterACookie })).status, 200);
    return job;
  };

  const closeJob = (jobId: number, cookie: string, body?: any) =>
    http('POST', `/api/v1/jobs/${jobId}/complete`, { cookie, ...(body !== undefined ? { body } : {}) });

  // ------------------------------ GATE WALKTHROUGH ------------------------------

  const jobMain = await mkJob('TCM001AA');

  await test('incomplete checklist blocks completion; DB state unchanged', async () => {
    const res = await closeJob(jobMain.jobId, masterACookie);
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'COMPLETION_BLOCKED');
    assert.ok(res.body.error.details.some((d: any) => d.code === 'CHECKLIST_INCOMPLETE'));
    const row = await db('jobs').where({ id: jobMain.jobId }).first();
    assert.equal(row.status, 'IN_PROGRESS');
    assert.equal(row.closed_at, null);
    const readiness = (await http('GET', `/api/v1/jobs/${jobMain.jobId}/completion`, { cookie: masterACookie })).body.readiness;
    assert.equal(readiness.canComplete, false);
    assert.equal(readiness.conditions.checklist, false);
  });

  await test('waiting STOP blocks completion (job leaves closable state)', async () => {
    assert.equal((await complete(jobMain.jobId, jobMain.steps[0].id)).status, 200);
    assert.equal((await uploadFile(photosPath(jobMain.jobId, jobMain.steps[1].id), 'photo', PNG_BYTES, ustaACookie)).status, 201);
    const measurementId = jobMain.steps[1].measurements[0].id;
    assert.equal((await complete(jobMain.jobId, jobMain.steps[1].id, { measurements: [{ measurementId, value: 15 }] })).status, 200);
    assert.equal((await uploadFile(photosPath(jobMain.jobId, jobMain.steps[2].id), 'photo', PNG_BYTES, ustaACookie)).status, 201);
    assert.equal((await complete(jobMain.jobId, jobMain.steps[2].id)).status, 200);

    const res = await closeJob(jobMain.jobId, masterACookie);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'JOB_NOT_CLOSABLE');
  });

  await test('rejected STOP blocks completion', async () => {
    assert.equal(
      (await http('POST', `/api/v1/jobs/${jobMain.jobId}/stop/reject`, { cookie: masterACookie, body: { reason: 'Sinov uchun rad' } })).status,
      200,
    );
    const res = await closeJob(jobMain.jobId, masterACookie);
    assert.equal(res.status, 409, 'REJECTED job is not closable');
    assert.equal((await db('jobs').where({ id: jobMain.jobId }).first()).status, 'REJECTED');
  });

  await test('after rework+approval the historical rejection does not block; signature becomes the blocker', async () => {
    assert.equal((await http('POST', `/api/v1/jobs/${jobMain.jobId}/stop/rework`, { cookie: ustaACookie })).status, 200);
    assert.equal((await uploadFile(photosPath(jobMain.jobId, jobMain.steps[2].id), 'photo', PNG_BYTES, ustaACookie)).status, 201);
    assert.equal((await complete(jobMain.jobId, jobMain.steps[2].id)).status, 200);
    assert.equal((await http('POST', `/api/v1/jobs/${jobMain.jobId}/stop/approve`, { cookie: masterACookie })).status, 200);

    const rejectedHistory = await db('stop_approvals').where({ job_id: jobMain.jobId, status: 'REJECTED' }).first();
    assert.ok(rejectedHistory, 'historical rejected attempt exists');

    const res = await closeJob(jobMain.jobId, masterACookie);
    assert.equal(res.status, 422);
    assert.deepEqual(res.body.error.details.map((d: any) => d.code), ['CUSTOMER_SIGNATURE_REQUIRED']);
  });

  await test('§22 re-verification catches missing photos and invalid measurements independently', async () => {
    // Corrupt state directly in the DB — the gate must catch what step-level
    // enforcement already passed.
    const photo = await db('job_photos').where({ job_step_id: jobMain.steps[1].id }).first();
    await db('job_photos').where({ id: photo.id }).del();
    let res = await http('GET', `/api/v1/jobs/${jobMain.jobId}/completion`, { cookie: masterACookie });
    assert.ok(res.body.readiness.reasons.some((r: any) => r.code === 'REQUIRED_PHOTOS_MISSING'));
    assert.equal((await closeJob(jobMain.jobId, masterACookie)).status, 422);
    const { id: _drop, ...photoData } = photo;
    await db('job_photos').insert(photoData);

    const value = await db('step_measurements').where({ job_step_id: jobMain.steps[1].id }).first();
    await db('step_measurements').where({ id: value.id }).update({ value: 25 });
    res = await http('GET', `/api/v1/jobs/${jobMain.jobId}/completion`, { cookie: masterACookie });
    assert.ok(res.body.readiness.reasons.some((r: any) => r.code === 'INVALID_MEASUREMENT'));
    assert.equal((await closeJob(jobMain.jobId, masterACookie)).status, 422);
    await db('step_measurements').where({ id: value.id }).update({ value: 15 });
  });

  // ------------------------------ SIGNATURE ------------------------------

  await test('signature security: auth, permission, branch scope, file validation', async () => {
    const sigPath = `/api/v1/jobs/${jobMain.jobId}/signature`;
    assert.equal((await uploadFile(sigPath, 'signature', PNG_BYTES)).status, 401);
    assert.equal((await uploadFile(sigPath, 'signature', PNG_BYTES, sifatCookie)).status, 403);
    assert.equal((await uploadFile(sigPath, 'signature', PNG_BYTES, ustaBCookie)).status, 404);
    const fake = await uploadFile(sigPath, 'signature', FAKE_IMAGE, ustaACookie);
    assert.equal(fake.status, 422);
    assert.equal(fake.body.error.code, 'INVALID_FILE_TYPE');
    assert.equal(await db('customer_signatures').where({ job_id: jobMain.jobId }).first(), undefined);
  });

  await test('signature cannot be captured before the checklist is complete', async () => {
    const jobSig = await mkJob('TCM002BB');
    const res = await uploadFile(`/api/v1/jobs/${jobSig.jobId}/signature`, 'signature', PNG_BYTES, ustaACookie);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'CHECKLIST_INCOMPLETE');
  });

  await test('valid signature is persisted with server-derived customer and hash; immutable once stored', async () => {
    const res = await uploadFile(`/api/v1/jobs/${jobMain.jobId}/signature`, 'signature', PNG_BYTES, ustaACookie);
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const row = await db('customer_signatures').where({ job_id: jobMain.jobId }).first();
    assert.ok(row, 'signature row must exist');
    assert.equal(row.customer_id, customerId, 'customer_id derived from the job, never from the client');
    assert.equal(row.hash, crypto.createHash('sha256').update(PNG_BYTES).digest('hex'));
    assert.match(row.storage_key, /^signatures\/\d+\/[0-9a-f-]{36}\.png$/);
    await fs.access(path.resolve('./uploads', row.storage_key));

    const audit = await db('audit_logs')
      .where({ action: 'CUSTOMER_SIGNED', entity_type: 'job', entity_id: String(jobMain.jobId) })
      .first();
    assert.ok(audit && audit.user_id === fx.ids.ustaA);

    const again = await uploadFile(`/api/v1/jobs/${jobMain.jobId}/signature`, 'signature', PNG_BYTES, ustaACookie);
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'SIGNATURE_EXISTS');

    const file = await fetch(`${baseUrl}/api/v1/jobs/${jobMain.jobId}/signature/file`, { headers: { cookie: masterACookie } });
    assert.equal(file.status, 200);
    assert.ok(Buffer.from(await file.arrayBuffer()).equals(PNG_BYTES));
    const crossBranch = await fetch(`${baseUrl}/api/v1/jobs/${jobMain.jobId}/signature/file`, { headers: { cookie: ustaBCookie } });
    assert.equal(crossBranch.status, 404);
  });

  // ------------------------------ CLOSE ------------------------------

  await test('only same-branch MASTER can close: USTA/SIFAT/ADMIN 403, cross-branch 404', async () => {
    for (const cookie of [ustaACookie, sifatCookie, adminCookie]) {
      assert.equal((await closeJob(jobMain.jobId, cookie)).status, 403);
    }
    assert.equal((await closeJob(jobMain.jobId, masterBCookie)).status, 404);
    assert.equal((await db('jobs').where({ id: jobMain.jobId }).first()).status, 'IN_PROGRESS');
  });

  await test('close succeeds when every §22 condition holds; client-sent fields ignored; audited', async () => {
    const res = await closeJob(jobMain.jobId, masterACookie, {
      status: 'CANCELLED',
      completed: true,
      closedBy: fx.ids.ustaA,
      photosComplete: true,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.job.status, 'COMPLETED');
    assert.equal(res.body.job.closedByName, 'Cm MasterA');

    const row = await db('jobs').where({ id: jobMain.jobId }).first();
    assert.equal(row.status, 'COMPLETED');
    assert.equal(row.closed_by, fx.ids.masterA, 'closer is the authenticated actor, never client-supplied');
    assert.ok(row.closed_at);

    const audit = await db('audit_logs')
      .where({ action: 'JOB_CLOSED', entity_type: 'job', entity_id: String(jobMain.jobId) })
      .first();
    assert.ok(audit && audit.user_id === fx.ids.masterA);
    const oldVal = typeof audit.old_value === 'string' ? JSON.parse(audit.old_value) : audit.old_value;
    assert.equal(oldVal.status, 'IN_PROGRESS');
  });

  await test('completed job cannot be closed again, cancelled, or reworked', async () => {
    assert.equal((await closeJob(jobMain.jobId, masterACookie)).status, 409);
    assert.equal(
      (await http('POST', `/api/v1/jobs/${jobMain.jobId}/cancel`, { cookie: ustaACookie, body: { reason: 'kech' } })).status,
      409,
    );
    assert.equal((await http('POST', `/api/v1/jobs/${jobMain.jobId}/stop/rework`, { cookie: ustaACookie })).status, 409);
  });

  await test('DRAFT and CANCELLED jobs cannot be closed; no generic status surface exists', async () => {
    const draft = await mkJob('TCM003CC', { start: false, checklist: false });
    assert.equal((await closeJob(draft.jobId, masterACookie)).status, 409);

    const cancelled = await mkJob('TCM004DD', { start: false, checklist: false });
    await http('POST', `/api/v1/jobs/${cancelled.jobId}/cancel`, { cookie: ustaACookie, body: { reason: 'Sinov' } });
    assert.equal((await closeJob(cancelled.jobId, masterACookie)).status, 409);

    assert.equal(
      (await http('PATCH', `/api/v1/jobs/${draft.jobId}`, { cookie: masterACookie, body: { status: 'COMPLETED' } })).status,
      404,
    );
    assert.equal(
      (await http('PATCH', `/api/v1/jobs/${draft.jobId}/completion`, { cookie: masterACookie, body: { canComplete: true } })).status,
      404,
    );
  });

  // ------------------------------ CONCURRENCY ------------------------------

  await test('two simultaneous close requests: exactly one succeeds, one JOB_CLOSED audit', async () => {
    const jobRace = await prepareReady('TCM005EE');
    assert.equal((await uploadFile(`/api/v1/jobs/${jobRace.jobId}/signature`, 'signature', PNG_BYTES, ustaACookie)).status, 201);

    const [a, b] = await Promise.all([closeJob(jobRace.jobId, masterACookie), closeJob(jobRace.jobId, masterA2Cookie)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409], `got ${a.status}/${b.status}`);
    const row = await db('jobs').where({ id: jobRace.jobId }).first();
    assert.equal(row.status, 'COMPLETED');
    const audits = await db('audit_logs')
      .where({ action: 'JOB_CLOSED', entity_type: 'job', entity_id: String(jobRace.jobId) })
      .count({ c: '*' });
    assert.equal(Number((audits as any)[0].c), 1, 'exactly one close audit');
  });

  await test('close racing a STOP approval stays deterministic (close cannot slip through)', async () => {
    // Job with STOP waiting: approve and close fired simultaneously.
    const job = await mkJob('TCM006FF');
    assert.equal((await complete(job.jobId, job.steps[0].id)).status, 200);
    assert.equal((await uploadFile(photosPath(job.jobId, job.steps[1].id), 'photo', PNG_BYTES, ustaACookie)).status, 201);
    const measurementId = job.steps[1].measurements[0].id;
    assert.equal((await complete(job.jobId, job.steps[1].id, { measurements: [{ measurementId, value: 12 }] })).status, 200);
    assert.equal((await uploadFile(photosPath(job.jobId, job.steps[2].id), 'photo', PNG_BYTES, ustaACookie)).status, 201);
    assert.equal((await complete(job.jobId, job.steps[2].id)).status, 200);

    const [approve, close] = await Promise.all([
      http('POST', `/api/v1/jobs/${job.jobId}/stop/approve`, { cookie: masterACookie }),
      closeJob(job.jobId, masterA2Cookie),
    ]);
    assert.equal(approve.status, 200, 'the pending approval must succeed');
    assert.notEqual(close.status, 200, 'close can never succeed without the signature/valid state');
    const row = await db('jobs').where({ id: job.jobId }).first();
    assert.equal(row.status, 'IN_PROGRESS', 'final state matches the approval outcome');
    assert.equal(row.closed_at, null);
  });

  // ------------------------------ FULL LIFECYCLE ------------------------------

  await test('full lifecycle: creation → checklist → STOP → signature → COMPLETED with complete audit chain', async () => {
    const job = await prepareReady('TCM007GG');
    assert.equal((await uploadFile(`/api/v1/jobs/${job.jobId}/signature`, 'signature', PNG_BYTES, ustaACookie)).status, 201);
    const readiness = (await http('GET', `/api/v1/jobs/${job.jobId}/completion`, { cookie: masterACookie })).body.readiness;
    assert.equal(readiness.canComplete, true);
    assert.deepEqual(readiness.conditions, { checklist: true, stops: true, photos: true, measurements: true, signature: true });

    assert.equal((await closeJob(job.jobId, masterACookie)).status, 200);
    assert.equal((await db('jobs').where({ id: job.jobId }).first()).status, 'COMPLETED');

    const checklistRow = await db('job_checklists').where({ job_id: job.jobId }).first();
    const stepIds = (await db('job_steps').where({ job_checklist_id: checklistRow.id }).select('id')).map(
      (s: { id: number }) => String(s.id),
    );
    const approvalIds = (await db('stop_approvals').where({ job_id: job.jobId }).select('id')).map(
      (a: { id: number }) => String(a.id),
    );
    const entityIds = [String(job.jobId), ...stepIds, ...approvalIds];
    for (const action of ['JOB_CREATED', 'JOB_STARTED', 'CHECKLIST_ASSIGNED', 'STEP_COMPLETED', 'STOP_SUBMITTED', 'STOP_APPROVED', 'CUSTOMER_SIGNED', 'JOB_CLOSED']) {
      const found = await db('audit_logs').where({ action }).whereIn('entity_id', entityIds).first();
      assert.ok(found, `audit chain missing ${action}`);
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
