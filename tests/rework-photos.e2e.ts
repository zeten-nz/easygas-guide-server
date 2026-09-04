/**
 * EASY GAS — Phase 7 STOP correction/rework + photo evidence E2E tests (§3, §19).
 *
 * Runs the Express app in-process against the real MySQL dev database and the
 * real local storage provider (migrations + seeds must be applied first).
 *
 *   npm run test:rework
 *
 * Fixtures: users +99899000930x, "TEST RW ..." names, TRW* plates.
 * Cleaned up (DB + storage files) before and after the run.
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
  admin: '+998990009301',
  ustaA: '+998990009302',
  masterA: '+998990009303',
  ustaB: '+998990009304',
  sifat: '+998990009305',
};

const PASSWORD = 'Sinov-parol-123';

// Real 1x1 transparent PNG.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const FAKE_PNG = Buffer.from('bu rasm emas, oddiy matn fayli — magic bytes mos kelmaydi!!');
const HUGE_PNG = Buffer.concat([PNG_BYTES, Buffer.alloc(11 * 1024 * 1024)]);

let baseUrl = '';

interface HttpResult {
  status: number;
  body: any;
  setCookies: string[];
  raw?: Response;
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

async function upload(
  pathname: string,
  bytes: Buffer,
  filename: string,
  cookie?: string,
  extraFields: Record<string, string> = {},
): Promise<HttpResult> {
  const form = new FormData();
  for (const [k, v] of Object.entries(extraFields)) form.append(k, v);
  form.append('photo', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), filename);
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: cookie ? { cookie } : {},
    body: form,
  });
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
// Fixtures
// ---------------------------------------------------------------------------

async function cleanup(): Promise<void> {
  const jobIds = (
    await db('jobs')
      .join('vehicles', 'vehicles.id', 'jobs.vehicle_id')
      .where('vehicles.plate_number', 'like', 'TRW%')
      .select('jobs.id')
  ).map((j: { id: number }) => j.id);
  if (jobIds.length > 0) {
    const photoIds = (await db('job_photos').whereIn('job_id', jobIds).select('id')).map((p: { id: number }) => p.id);
    if (photoIds.length > 0) {
      await db('audit_logs').where('entity_type', 'job_photo').whereIn('entity_id', photoIds.map(String)).del();
    }
    await db('job_photos').whereIn('job_id', jobIds).del();
    for (const jobId of jobIds) {
      await fs.rm(path.resolve('./uploads/photos', String(jobId)), { recursive: true, force: true });
    }
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

  const templateIds = (await db('checklist_templates').where('name', 'like', 'TEST RW%').select('id')).map(
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

  const customerIds = (await db('customers').where('name', 'like', 'TEST RW%').select('id')).map(
    (c: { id: number }) => c.id,
  );
  await db('vehicles').where('plate_number', 'like', 'TRW%').del();
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
  await db('branches').where('name', 'like', 'TEST RW%').del();
}

async function createFixtures() {
  const roles = await db('roles').select('id', 'code');
  const roleId = (code: string) => roles.find((r: { code: string }) => r.code === code)?.id;
  const [branchA] = await db('branches').insert({ name: 'TEST RW Branch A', region: 'Toshkent shahri', status: 'ACTIVE' });
  const [branchB] = await db('branches').insert({ name: 'TEST RW Branch B', region: 'Samarqand', status: 'ACTIVE' });

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const base = { password_hash: passwordHash, region: 'Toshkent shahri', status: 'ACTIVE' };
  const insert = async (row: Record<string, unknown>) => {
    const [id] = await db('users').insert(row);
    return id as number;
  };

  const ids: Record<string, number> = {};
  ids.admin = await insert({ ...base, first_name: 'Rw', last_name: 'Admin', phone: USERS.admin, branch_id: null, role_id: roleId('ADMIN') });
  ids.ustaA = await insert({ ...base, first_name: 'Rw', last_name: 'UstaA', phone: USERS.ustaA, branch_id: branchA, role_id: roleId('USTA') });
  ids.masterA = await insert({ ...base, first_name: 'Rw', last_name: 'MasterA', phone: USERS.masterA, branch_id: branchA, role_id: roleId('MASTER') });
  ids.ustaB = await insert({ ...base, first_name: 'Rw', last_name: 'UstaB', phone: USERS.ustaB, branch_id: branchB, role_id: roleId('USTA') });
  ids.sifat = await insert({ ...base, first_name: 'Rw', last_name: 'Sifat', phone: USERS.sifat, branch_id: null, role_id: roleId('SIFAT') });

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

  console.log(`\nRunning rework+photos E2E against ${baseUrl}\n`);

  const adminCookie = await login(USERS.admin);
  const ustaACookie = await login(USERS.ustaA);
  const masterACookie = await login(USERS.masterA);
  const ustaBCookie = await login(USERS.ustaB);
  const sifatCookie = await login(USERS.sifat);

  // Business fixtures
  const c = await http('POST', '/api/v1/customers', {
    cookie: ustaACookie,
    body: { name: 'TEST RW Mijoz', phone: '99 000 93 11' },
  });
  const customerId = c.body.customer.id as number;
  const mkVehicle = async (plate: string) =>
    (await http('POST', '/api/v1/vehicles', { cookie: ustaACookie, body: { customerId, plateNumber: plate, make: 'Chevrolet', model: 'Gentra' } }))
      .body.vehicle.id as number;
  const vehicleA = await mkVehicle('TRW001AA');
  const vehicleB = await mkVehicle('TRW002BB');
  const vehicleC = await mkVehicle('TRW003CC');

  // Template: s1 plain, s2 normal + 1 required photo, s3 STOP + 2 photos + measurement
  const t = await http('POST', '/api/v1/checklist-templates', { cookie: adminCookie, body: { name: 'TEST RW Shablon' } });
  const templateId = t.body.template.id as number;
  const versionId = t.body.template.versions[0].id as number;
  for (const step of [
    { name: 'Tayyorgarlik' },
    { name: 'Montaj hujjatlash', requiredPhotos: 1 },
    {
      name: 'Reduktor STOP',
      isStop: true,
      requiredPhotos: 2,
      measurements: [{ name: 'Ish bosimi', unit: 'bar', minValue: 0.9, maxValue: 1.4, required: true }],
    },
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

  const mkJob = async (vehicleId: number) => {
    const j = await http('POST', '/api/v1/jobs', { cookie: ustaACookie, body: { customerId, vehicleId } });
    const jobId = j.body.job.id as number;
    await http('POST', `/api/v1/jobs/${jobId}/start`, { cookie: ustaACookie });
    const a = await http('POST', `/api/v1/jobs/${jobId}/checklist`, { cookie: ustaACookie, body: { templateId } });
    return { jobId, steps: a.body.checklist.steps as any[] };
  };
  const jobA = await mkJob(vehicleA); // rework cycles
  const jobB = await mkJob(vehicleB); // parity + photo enforcement
  const jobC = await mkJob(vehicleC); // concurrency

  const photosPath = (jobId: number, stepId: number) => `/api/v1/jobs/${jobId}/checklist/steps/${stepId}/photos`;
  const complete = (jobId: number, stepId: number, cookie: string, body: any = {}) =>
    http('POST', `/api/v1/jobs/${jobId}/checklist/steps/${stepId}/complete`, { cookie, body });

  // ---------------- PHOTOS ----------------

  await test('photo upload requires auth, permission and branch access', async () => {
    assert.equal((await upload(photosPath(jobB.jobId, jobB.steps[1].id), PNG_BYTES, 'a.png')).status, 401);
    assert.equal((await upload(photosPath(jobB.jobId, jobB.steps[1].id), PNG_BYTES, 'a.png', sifatCookie)).status, 403);
    assert.equal((await upload(photosPath(jobB.jobId, jobB.steps[1].id), PNG_BYTES, 'a.png', ustaBCookie)).status, 404);
  });

  await test('non-image bytes and oversized files are rejected', async () => {
    const fake = await upload(photosPath(jobB.jobId, jobB.steps[1].id), FAKE_PNG, 'fake.png', ustaACookie);
    assert.equal(fake.status, 422);
    assert.equal(fake.body.error.code, 'INVALID_FILE_TYPE');
    const huge = await upload(photosPath(jobB.jobId, jobB.steps[1].id), HUGE_PNG, 'huge.png', ustaACookie);
    assert.equal(huge.status, 422);
    assert.equal(huge.body.error.code, 'FILE_TOO_LARGE');
    assert.equal(Number((((await db('job_photos').where({ job_id: jobB.jobId }).count({ c: '*' })) as any)[0]).c), 0);
  });

  await test('required photo count is enforced from real records, not client claims', async () => {
    assert.equal((await complete(jobB.jobId, jobB.steps[0].id, ustaACookie)).status, 200);
    const without = await complete(jobB.jobId, jobB.steps[1].id, ustaACookie);
    assert.equal(without.status, 422);
    assert.equal(without.body.error.code, 'PHOTOS_REQUIRED');
    const faked = await complete(jobB.jobId, jobB.steps[1].id, ustaACookie, { photoCount: 5, photosUploaded: true });
    assert.equal(faked.status, 422, 'client-claimed photo counts must be ignored');
  });

  let uploadedPhotoId = 0;
  await test('upload stores safe server-generated key, session uploader and full metadata', async () => {
    const res = await upload(
      photosPath(jobB.jobId, jobB.steps[1].id),
      PNG_BYTES,
      '..\\..\\evil.png',
      ustaACookie,
      { uploadedBy: '1', jobId: '999999', branchId: '999' }, // ignored fields
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
    uploadedPhotoId = res.body.photo.id;
    assert.equal(res.body.photo.attempt, 1);

    const row = await db('job_photos').where({ id: uploadedPhotoId }).first();
    assert.equal(row.created_by, fx.ids.ustaA, 'uploader comes from the session');
    assert.equal(row.job_id, jobB.jobId, 'job relation comes from the route, not the form');
    assert.equal(row.job_step_id, jobB.steps[1].id);
    assert.match(row.storage_key, /^photos\/\d+\/\d+\/[0-9a-f-]{36}\.png$/, 'storage key is server-generated');
    assert.ok(!row.storage_key.includes('..'), 'no traversal in storage key');
    // The multipart parser strips path components from client filenames —
    // only the basename ever reaches metadata (traversal removed even there).
    assert.equal(row.original_name, 'evil.png');
    assert.equal(row.mime_type, 'image/png');
    assert.equal(row.size_bytes, PNG_BYTES.length);
    assert.equal(row.hash, crypto.createHash('sha256').update(PNG_BYTES).digest('hex'));
    await fs.access(path.resolve('./uploads', row.storage_key)); // file really exists inside the storage root
  });

  await test('sufficient photos permit completion; step then freezes for uploads', async () => {
    assert.equal((await complete(jobB.jobId, jobB.steps[1].id, ustaACookie)).status, 200);
    const late = await upload(photosPath(jobB.jobId, jobB.steps[1].id), PNG_BYTES, 'late.png', ustaACookie);
    assert.equal(late.status, 409, 'no uploads to a completed step');
    assert.equal(late.body.error.code, 'STEP_NOT_PENDING');
  });

  await test('STOP requiring photos cannot be submitted without evidence', async () => {
    const pressureId = jobB.steps[2].measurements[0].id;
    const res = await complete(jobB.jobId, jobB.steps[2].id, ustaACookie, {
      measurements: [{ measurementId: pressureId, value: 1.2 }],
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'PHOTOS_REQUIRED');
  });

  await test('with evidence the STOP submits; Master sees photos and approves (Phase 6 parity)', async () => {
    assert.equal((await upload(photosPath(jobB.jobId, jobB.steps[2].id), PNG_BYTES, 'p1.png', ustaACookie)).status, 201);
    assert.equal((await upload(photosPath(jobB.jobId, jobB.steps[2].id), PNG_BYTES, 'p2.png', ustaACookie)).status, 201);
    const pressureId = jobB.steps[2].measurements[0].id;
    assert.equal(
      (await complete(jobB.jobId, jobB.steps[2].id, ustaACookie, { measurements: [{ measurementId: pressureId, value: 1.2 }] })).status,
      200,
    );

    const view = (await http('GET', `/api/v1/jobs/${jobB.jobId}/checklist`, { cookie: masterACookie })).body.checklist;
    const stopStep = view.steps[2];
    assert.equal(stopStep.status, 'WAITING_APPROVAL');
    assert.equal(stopStep.photos.length, 2, 'Master must see the evidence');

    const fileRes = await fetch(`${baseUrl}${photosPath(jobB.jobId, jobB.steps[2].id)}/${stopStep.photos[0].id}/file`, {
      headers: { cookie: masterACookie },
    });
    assert.equal(fileRes.status, 200);
    assert.equal(fileRes.headers.get('content-type'), 'image/png');
    assert.ok(Buffer.from(await fileRes.arrayBuffer()).equals(PNG_BYTES), 'served bytes match the upload');

    assert.equal((await http('POST', `/api/v1/jobs/${jobB.jobId}/stop/approve`, { cookie: masterACookie })).status, 200);
    const jobRow = await db('jobs').where({ id: jobB.jobId }).first();
    assert.equal(jobRow.status, 'IN_PROGRESS');
  });

  await test('photos are inaccessible cross-branch and have no delete surface', async () => {
    const fileRes = await fetch(`${baseUrl}${photosPath(jobB.jobId, jobB.steps[1].id)}/${uploadedPhotoId}/file`, {
      headers: { cookie: ustaBCookie },
    });
    assert.equal(fileRes.status, 404, 'cross-branch photo access must 404');
    assert.equal(
      (await http('DELETE', `${photosPath(jobB.jobId, jobB.steps[1].id)}/${uploadedPhotoId}`, { cookie: adminCookie })).status,
      404,
      'photos are immutable evidence — no delete route',
    );
  });

  // ---------------- REWORK ----------------

  const pressureIdA = jobA.steps[2].measurements[0].id;
  await test('setup: jobA STOP submitted with evidence and rejected', async () => {
    assert.equal((await complete(jobA.jobId, jobA.steps[0].id, ustaACookie)).status, 200);
    assert.equal((await upload(photosPath(jobA.jobId, jobA.steps[1].id), PNG_BYTES, 's2.png', ustaACookie)).status, 201);
    assert.equal((await complete(jobA.jobId, jobA.steps[1].id, ustaACookie)).status, 200);
    assert.equal((await upload(photosPath(jobA.jobId, jobA.steps[2].id), PNG_BYTES, 'a1.png', ustaACookie)).status, 201);
    assert.equal((await upload(photosPath(jobA.jobId, jobA.steps[2].id), PNG_BYTES, 'a2.png', ustaACookie)).status, 201);
    assert.equal(
      (await complete(jobA.jobId, jobA.steps[2].id, ustaACookie, { measurements: [{ measurementId: pressureIdA, value: 1.0 }] })).status,
      200,
    );
    assert.equal(
      (await http('POST', `/api/v1/jobs/${jobA.jobId}/stop/reject`, { cookie: masterACookie, body: { reason: "O'rnatish noto'g'ri bajarilgan" } })).status,
      200,
    );
    assert.equal((await db('jobs').where({ id: jobA.jobId }).first()).status, 'REJECTED');
  });

  await test('unauthorized users cannot start correction', async () => {
    assert.equal((await http('POST', `/api/v1/jobs/${jobA.jobId}/stop/rework`)).status, 401);
    assert.equal((await http('POST', `/api/v1/jobs/${jobA.jobId}/stop/rework`, { cookie: sifatCookie })).status, 403);
    assert.equal((await http('POST', `/api/v1/jobs/${jobA.jobId}/stop/rework`, { cookie: ustaBCookie })).status, 404);
    assert.equal((await db('jobs').where({ id: jobA.jobId }).first()).status, 'REJECTED', 'state untouched');
  });

  await test('rework is refused on non-REJECTED jobs; no generic status mutation exists', async () => {
    const notRejected = await http('POST', `/api/v1/jobs/${jobB.jobId}/stop/rework`, { cookie: ustaACookie });
    assert.equal(notRejected.status, 409);
    assert.equal(notRejected.body.error.code, 'JOB_NOT_REJECTED');
    assert.equal(
      (await http('PATCH', `/api/v1/jobs/${jobA.jobId}`, { cookie: ustaACookie, body: { status: 'IN_PROGRESS' } })).status,
      404,
      'there is no generic job status PATCH',
    );
  });

  await test('technician starts correction: job IN_PROGRESS, step re-opens, audited; history intact', async () => {
    const res = await http('POST', `/api/v1/jobs/${jobA.jobId}/stop/rework`, { cookie: ustaACookie });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const stopStep = res.body.checklist.steps[2];
    assert.equal(stopStep.status, 'PENDING');
    assert.equal(stopStep.isCurrent, true, 'the reworked step becomes current again');
    assert.equal(stopStep.currentAttempt, 2);
    assert.equal((await db('jobs').where({ id: jobA.jobId }).first()).status, 'IN_PROGRESS');

    const approval = await db('stop_approvals').where({ job_id: jobA.jobId }).first();
    assert.equal(approval.status, 'REJECTED', 'historical decision untouched');
    assert.equal(approval.reject_reason, "O'rnatish noto'g'ri bajarilgan");

    const audit = await db('audit_logs')
      .where({ action: 'STOP_CORRECTION_STARTED', entity_type: 'job_step', entity_id: String(jobA.steps[2].id) })
      .first();
    assert.ok(audit && audit.user_id === fx.ids.ustaA);
  });

  await test('the corrected attempt needs FRESH photos — rejected evidence does not carry over', async () => {
    const res = await complete(jobA.jobId, jobA.steps[2].id, ustaACookie, {
      measurements: [{ measurementId: pressureIdA, value: 1.2 }],
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'PHOTOS_REQUIRED');
    const attempt1Count = await db('job_photos').where({ job_step_id: jobA.steps[2].id, attempt: 1 }).count({ c: '*' });
    assert.equal(Number((attempt1Count as any)[0].c), 2, 'attempt-1 photos are preserved but do not count');
  });

  await test('resubmission with new evidence creates a NEW approval record (attempt 2)', async () => {
    assert.equal((await upload(photosPath(jobA.jobId, jobA.steps[2].id), PNG_BYTES, 'b1.png', ustaACookie)).status, 201);
    assert.equal((await upload(photosPath(jobA.jobId, jobA.steps[2].id), PNG_BYTES, 'b2.png', ustaACookie)).status, 201);
    const newPhotos = await db('job_photos').where({ job_step_id: jobA.steps[2].id, attempt: 2 });
    assert.equal(newPhotos.length, 2, 'new uploads belong to attempt 2');

    const res = await complete(jobA.jobId, jobA.steps[2].id, ustaACookie, {
      measurements: [{ measurementId: pressureIdA, value: 1.3 }],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.checklist.steps[2].status, 'WAITING_APPROVAL');
    assert.equal(res.body.checklist.steps[2].stopApproval.attempt, 2);

    const records = await db('stop_approvals').where({ job_id: jobA.jobId }).orderBy('id');
    assert.equal(records.length, 2, 'both attempts recorded');
    assert.equal(records[0].status, 'REJECTED');
    assert.equal(records[1].status, 'PENDING');
    assert.equal(records[1].attempt, 2);

    const values = await db('step_measurements').where({ job_step_id: jobA.steps[2].id }).orderBy('attempt');
    assert.deepEqual(values.map((v: any) => [v.attempt, Number(v.value)]), [[1, 1.0], [2, 1.3]], 'both attempts\' values preserved');
  });

  await test('resubmission never auto-approves — a new Master decision is required', async () => {
    assert.equal((await db('jobs').where({ id: jobA.jobId }).first()).status, 'WAITING_STOP_APPROVAL');
    assert.equal((await http('POST', `/api/v1/jobs/${jobA.jobId}/stop/approve`, { cookie: ustaACookie })).status, 403);
    const nextStep = await complete(jobA.jobId, jobA.steps[2].id, ustaACookie, {});
    assert.equal(nextStep.status, 409, 'work stays blocked while waiting');
  });

  await test('Master rejects attempt 2; both rejection records stay independent', async () => {
    const blank = await http('POST', `/api/v1/jobs/${jobA.jobId}/stop/reject`, { cookie: masterACookie, body: { reason: ' ' } });
    assert.equal(blank.status, 422, 'reason stays mandatory on reworked attempts');
    assert.equal(
      (await http('POST', `/api/v1/jobs/${jobA.jobId}/stop/reject`, { cookie: masterACookie, body: { reason: 'Bosim hali beqaror' } })).status,
      200,
    );
    const records = await db('stop_approvals').where({ job_id: jobA.jobId }).orderBy('id');
    assert.equal(records[0].reject_reason, "O'rnatish noto'g'ri bajarilgan", 'attempt-1 reason unchanged');
    assert.equal(records[1].reject_reason, 'Bosim hali beqaror');
    const oldAudit = await db('audit_logs')
      .where({ action: 'STOP_REJECTED', entity_type: 'stop_approval', entity_id: String(records[0].id) })
      .first();
    assert.ok(oldAudit, 'attempt-1 audit remains');
  });

  await test('second correction cycle: rework → new evidence → resubmit → Master approves attempt 3', async () => {
    assert.equal((await http('POST', `/api/v1/jobs/${jobA.jobId}/stop/rework`, { cookie: ustaACookie })).status, 200);
    assert.equal((await upload(photosPath(jobA.jobId, jobA.steps[2].id), PNG_BYTES, 'c1.png', ustaACookie)).status, 201);
    assert.equal((await upload(photosPath(jobA.jobId, jobA.steps[2].id), PNG_BYTES, 'c2.png', ustaACookie)).status, 201);
    assert.equal(
      (await complete(jobA.jobId, jobA.steps[2].id, ustaACookie, { measurements: [{ measurementId: pressureIdA, value: 1.2 }] })).status,
      200,
    );
    assert.equal((await http('POST', `/api/v1/jobs/${jobA.jobId}/stop/approve`, { cookie: masterACookie })).status, 200);

    const step = await db('job_steps').where({ id: jobA.steps[2].id }).first();
    assert.equal(step.status, 'APPROVED');
    assert.equal((await db('jobs').where({ id: jobA.jobId }).first()).status, 'IN_PROGRESS');
    const records = await db('stop_approvals').where({ job_id: jobA.jobId }).orderBy('id');
    assert.deepEqual(records.map((r: any) => [r.attempt, r.status]), [[1, 'REJECTED'], [2, 'REJECTED'], [3, 'APPROVED']]);
    const photoCount = await db('job_photos').where({ job_step_id: jobA.steps[2].id }).count({ c: '*' });
    assert.equal(Number((photoCount as any)[0].c), 6, 'all attempts\' evidence preserved (2+2+2)');

    const dupRework = await http('POST', `/api/v1/jobs/${jobA.jobId}/stop/rework`, { cookie: ustaACookie });
    assert.equal(dupRework.status, 409, 'rework impossible once approved');
  });

  await test('concurrent rework attempts: exactly one succeeds', async () => {
    // Prepare a rejected STOP on jobC
    assert.equal((await complete(jobC.jobId, jobC.steps[0].id, ustaACookie)).status, 200);
    assert.equal((await upload(photosPath(jobC.jobId, jobC.steps[1].id), PNG_BYTES, 'c.png', ustaACookie)).status, 201);
    assert.equal((await complete(jobC.jobId, jobC.steps[1].id, ustaACookie)).status, 200);
    assert.equal((await upload(photosPath(jobC.jobId, jobC.steps[2].id), PNG_BYTES, 'd1.png', ustaACookie)).status, 201);
    assert.equal((await upload(photosPath(jobC.jobId, jobC.steps[2].id), PNG_BYTES, 'd2.png', ustaACookie)).status, 201);
    const pressureIdC = jobC.steps[2].measurements[0].id;
    assert.equal(
      (await complete(jobC.jobId, jobC.steps[2].id, ustaACookie, { measurements: [{ measurementId: pressureIdC, value: 1.1 }] })).status,
      200,
    );
    assert.equal(
      (await http('POST', `/api/v1/jobs/${jobC.jobId}/stop/reject`, { cookie: masterACookie, body: { reason: 'Qayta tekshirilsin' } })).status,
      200,
    );

    const [a, b] = await Promise.all([
      http('POST', `/api/v1/jobs/${jobC.jobId}/stop/rework`, { cookie: ustaACookie }),
      http('POST', `/api/v1/jobs/${jobC.jobId}/stop/rework`, { cookie: masterACookie }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409], `got ${a.status}/${b.status}`);
    assert.equal((await db('jobs').where({ id: jobC.jobId }).first()).status, 'IN_PROGRESS');
    const auditCount = await db('audit_logs')
      .where({ action: 'STOP_CORRECTION_STARTED', entity_type: 'job_step', entity_id: String(jobC.steps[2].id) })
      .count({ c: '*' });
    assert.equal(Number((auditCount as any)[0].c), 1, 'exactly one correction start recorded');
  });

  await test('concurrent uploads stay consistent (attempt-scoped, exact counts)', async () => {
    const [u1, u2] = await Promise.all([
      upload(photosPath(jobC.jobId, jobC.steps[2].id), PNG_BYTES, 'e1.png', ustaACookie),
      upload(photosPath(jobC.jobId, jobC.steps[2].id), PNG_BYTES, 'e2.png', ustaACookie),
    ]);
    assert.equal(u1.status, 201);
    assert.equal(u2.status, 201);
    const rows = await db('job_photos').where({ job_step_id: jobC.steps[2].id, attempt: 2 });
    assert.equal(rows.length, 2, 'both concurrent uploads recorded in attempt 2 exactly once each');
  });

  await test('all Phase 7 audit actions exist with correct actor attribution', async () => {
    for (const [action, actorId] of [
      ['STOP_CORRECTION_STARTED', fx.ids.ustaA],
      ['PHOTO_UPLOADED', fx.ids.ustaA],
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
