/**
 * EASY GAS — Phase 9 Quality Control + Reopen E2E tests (§24–26).
 *
 * Runs the Express app in-process against real MySQL + local storage
 * (migrations + seeds must be applied first).
 *
 *   npm run test:quality
 *
 * Fixtures: users +99899000890x, "TEST QC ..." names, TQC* plates.
 * Cleaned up (DB + storage) before and after the run.
 */
import { assertTestDatabase } from './helpers/test-env'; // MUST be first: NODE_ENV=test + *_test DB
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcrypt';
import { db } from '../src/config/database';
import { createApp } from '../src/app';
import { csrfTokenFor } from '../src/middleware/csrf.middleware';
import { setSmsProviderForTesting } from '../src/sms';

const USERS = {
  admin: '+998990008901',
  ustaA: '+998990008902',
  masterA: '+998990008903',
  ustaB: '+998990008904',
  masterB: '+998990008905',
  sifat: '+998990008906',
  sifat2: '+998990008907',
  rahbarA: '+998990008908',
};

const PASSWORD = 'Sinov-parol-123';
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let baseUrl = '';

interface HttpResult {
  status: number;
  body: any;
  setCookies: string[];
}

async function http(method: string, pathname: string, opts: { body?: unknown; cookie?: string } = {}): Promise<HttpResult> {
  const res = await fetch(`${baseUrl}${pathname}`, {
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

async function uploadFile(pathname: string, field: string, bytes: Buffer, cookie?: string): Promise<HttpResult> {
  const form = new FormData();
  form.append(field, new Blob([new Uint8Array(bytes)], { type: 'image/png' }), 'file.png');
  const res = await fetch(`${baseUrl}${pathname}`, { method: 'POST', headers: cookie ? { cookie, 'x-csrf-token': csrfTokenFor(cookie.split('=')[1] ?? '') } : {}, body: form });
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
// Cleanup / fixtures (same chain as the completion suite, TQC/TEST QC scope)
// ---------------------------------------------------------------------------

async function cleanup(): Promise<void> {
  const jobIds = (
    await db('jobs')
      .join('vehicles', 'vehicles.id', 'jobs.vehicle_id')
      .where('vehicles.plate_number', 'like', 'TQC%')
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
    await db('risk_events').whereIn('job_id', jobIds).del();
    await db('completion_snapshots').whereIn('job_id', jobIds).del();
    await db('job_assignments').whereIn('job_id', jobIds).del();
    await db('jobs').whereIn('id', jobIds).del();
  }

  const templateIds = (await db('checklist_templates').where('name', 'like', 'TEST QC%').select('id')).map(
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

  const customerIds = (await db('customers').where('name', 'like', 'TEST QC%').select('id')).map(
    (c: { id: number }) => c.id,
  );
  await db('vehicles').where('plate_number', 'like', 'TQC%').del();
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
  await db('branches').where('name', 'like', 'TEST QC%').del();
}

async function createFixtures() {
  const roles = await db('roles').select('id', 'code');
  const roleId = (code: string) => roles.find((r: { code: string }) => r.code === code)?.id;
  const [branchA] = await db('branches').insert({ name: 'TEST QC Branch A', region: 'Toshkent shahri', status: 'ACTIVE' });
  const [branchB] = await db('branches').insert({ name: 'TEST QC Branch B', region: 'Samarqand', status: 'ACTIVE' });

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const base = { password_hash: passwordHash, region: 'Toshkent shahri', status: 'ACTIVE' };
  const insert = async (row: Record<string, unknown>) => {
    const [id] = await db('users').insert(row);
    return id as number;
  };

  const ids: Record<string, number> = {};
  ids.admin = await insert({ ...base, first_name: 'Qc', last_name: 'Admin', phone: USERS.admin, branch_id: null, role_id: roleId('ADMIN') });
  ids.ustaA = await insert({ ...base, first_name: 'Qc', last_name: 'UstaA', phone: USERS.ustaA, branch_id: branchA, role_id: roleId('USTA') });
  ids.masterA = await insert({ ...base, first_name: 'Qc', last_name: 'MasterA', phone: USERS.masterA, branch_id: branchA, role_id: roleId('MASTER') });
  ids.ustaB = await insert({ ...base, first_name: 'Qc', last_name: 'UstaB', phone: USERS.ustaB, branch_id: branchB, role_id: roleId('USTA') });
  ids.masterB = await insert({ ...base, first_name: 'Qc', last_name: 'MasterB', phone: USERS.masterB, branch_id: branchB, role_id: roleId('MASTER') });
  ids.sifat = await insert({ ...base, first_name: 'Qc', last_name: 'Sifat', phone: USERS.sifat, branch_id: null, role_id: roleId('SIFAT') });
  ids.sifat2 = await insert({ ...base, first_name: 'Qc', last_name: 'Sifat2', phone: USERS.sifat2, branch_id: null, role_id: roleId('SIFAT') });
  ids.rahbarA = await insert({ ...base, first_name: 'Qc', last_name: 'RahbarA', phone: USERS.rahbarA, branch_id: branchA, role_id: roleId('RAHBAR') });

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

  console.log(`\nRunning quality E2E against ${baseUrl}\n`);

  const adminCookie = await login(USERS.admin);
  const ustaACookie = await login(USERS.ustaA);
  const masterACookie = await login(USERS.masterA);
  const ustaBCookie = await login(USERS.ustaB);
  const masterBCookie = await login(USERS.masterB);
  const sifatCookie = await login(USERS.sifat);
  const sifat2Cookie = await login(USERS.sifat2);
  const rahbarACookie = await login(USERS.rahbarA);

  const c = await http('POST', '/api/v1/customers', {
    cookie: ustaACookie,
    body: { name: 'TEST QC Mijoz', phone: '99 000 89 11' },
  });
  const customerId = c.body.customer.id as number;
  const mkVehicle = async (plate: string) =>
    (await http('POST', '/api/v1/vehicles', { cookie: ustaACookie, body: { customerId, plateNumber: plate, make: 'Chevrolet', model: 'Tracker' } }))
      .body.vehicle.id as number;

  const t = await http('POST', '/api/v1/checklist-templates', { cookie: adminCookie, body: { name: 'TEST QC Shablon' } });
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

  /** Full first-cycle lifecycle → COMPLETED. */
  const prepareCompleted = async (plate: string) => {
    const vehicleId = await mkVehicle(plate);
    const j = await http('POST', '/api/v1/jobs', { cookie: ustaACookie, body: { customerId, vehicleId } });
    const jobId = j.body.job.id as number;
    await http('POST', `/api/v1/jobs/${jobId}/start`, { cookie: ustaACookie });
    const a = await http('POST', `/api/v1/jobs/${jobId}/checklist`, { cookie: ustaACookie, body: { templateId } });
    const steps = a.body.checklist.steps as any[];
    assert.equal((await complete(jobId, steps[0].id)).status, 200);
    assert.equal((await uploadFile(photosPath(jobId, steps[1].id), 'photo', PNG_BYTES, ustaACookie)).status, 201);
    assert.equal(
      (await complete(jobId, steps[1].id, { measurements: [{ measurementId: steps[1].measurements[0].id, value: 15 }] })).status,
      200,
    );
    assert.equal((await uploadFile(photosPath(jobId, steps[2].id), 'photo', PNG_BYTES, ustaACookie)).status, 201);
    assert.equal((await complete(jobId, steps[2].id)).status, 200);
    assert.equal((await http('POST', `/api/v1/jobs/${jobId}/stop/approve`, { cookie: masterACookie })).status, 200);
    assert.equal((await uploadFile(`/api/v1/jobs/${jobId}/signature`, 'signature', PNG_BYTES, ustaACookie)).status, 201);
    assert.equal((await http('POST', `/api/v1/jobs/${jobId}/complete`, { cookie: masterACookie })).status, 200);
    return { jobId, steps };
  };

  const jobMain = await prepareCompleted('TQC001AA');

  // ---------------- INSPECTION ----------------

  await test('quality authority (SIFAT, ADMIN) can inspect a completed job in full', async () => {
    for (const cookie of [sifatCookie, adminCookie]) {
      const res = await http('GET', `/api/v1/jobs/${jobMain.jobId}/quality`, { cookie });
      assert.equal(res.status, 200);
      assert.equal(res.body.job.id, jobMain.jobId);
      assert.equal(res.body.checklist.steps.length, 3);
      assert.equal(res.body.stopApprovals.length, 1);
      assert.ok(res.body.signature, 'signature visible to quality');
      assert.equal(res.body.readiness.canComplete, true);
      assert.ok(res.body.timeline.length >= 5, 'audit timeline present');
      assert.ok(res.body.timeline.some((e: any) => e.action === 'JOB_CLOSED'));
    }
  });

  await test('non-quality roles cannot use the quality endpoint', async () => {
    for (const cookie of [ustaACookie, masterACookie, rahbarACookie]) {
      assert.equal((await http('GET', `/api/v1/jobs/${jobMain.jobId}/quality`, { cookie })).status, 403);
    }
    assert.equal((await http('GET', `/api/v1/jobs/${jobMain.jobId}/quality`)).status, 401);
  });

  // ---------------- REOPEN ----------------

  await test('only SIFAT/ADMIN may reopen; others 403/401 with state untouched', async () => {
    for (const cookie of [ustaACookie, masterACookie, rahbarACookie]) {
      assert.equal(
        (await http('POST', `/api/v1/jobs/${jobMain.jobId}/reopen`, { cookie, body: { reason: 'sinov sababi' } })).status,
        403,
      );
    }
    assert.equal((await http('POST', `/api/v1/jobs/${jobMain.jobId}/reopen`, { body: { reason: 'sinov sababi' } })).status, 401);
    assert.equal((await db('jobs').where({ id: jobMain.jobId }).first()).status, 'COMPLETED');
  });

  await test('reopen validation: reason mandatory/trimmed/bounded; state must be COMPLETED', async () => {
    assert.equal((await http('POST', `/api/v1/jobs/${jobMain.jobId}/reopen`, { cookie: sifatCookie, body: {} })).status, 422);
    assert.equal(
      (await http('POST', `/api/v1/jobs/${jobMain.jobId}/reopen`, { cookie: sifatCookie, body: { reason: '   ' } })).status,
      422,
    );
    assert.equal(
      (await http('POST', `/api/v1/jobs/${jobMain.jobId}/reopen`, { cookie: sifatCookie, body: { reason: 'ab' } })).status,
      422,
    );
    assert.equal(
      (await http('POST', `/api/v1/jobs/${jobMain.jobId}/reopen`, { cookie: sifatCookie, body: { reason: 'x'.repeat(501) } }))
        .status,
      422,
    );

    // Non-completed jobs cannot be reopened
    const vehicleId = await mkVehicle('TQC002BB');
    const draft = await http('POST', '/api/v1/jobs', { cookie: ustaACookie, body: { customerId, vehicleId } });
    const res = await http('POST', `/api/v1/jobs/${draft.body.job.id}/reopen`, {
      cookie: sifatCookie,
      body: { reason: 'sinov sababi' },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'JOB_NOT_COMPLETED');
  });

  let originalClosedAt: Date;
  let originalClosedBy: number;
  await test('reopen succeeds: §24 fields stored, fabricated client fields ignored, original completion preserved', async () => {
    const before = await db('jobs').where({ id: jobMain.jobId }).first();
    originalClosedAt = before.closed_at;
    originalClosedBy = before.closed_by;

    const res = await http('POST', `/api/v1/jobs/${jobMain.jobId}/reopen`, {
      cookie: sifatCookie,
      body: { reason: "Reduktor sozlamasi shubhali — qayta tekshirilsin", status: 'COMPLETED', reopenedBy: fx.ids.ustaA, reopenedAt: '1999-01-01' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.job.status, 'REOPENED');
    assert.equal(res.body.job.reopenedByName, 'Qc Sifat');

    const row = await db('jobs').where({ id: jobMain.jobId }).first();
    assert.equal(row.status, 'REOPENED');
    assert.equal(row.reopen_reason, "Reduktor sozlamasi shubhali — qayta tekshirilsin");
    assert.equal(row.reopened_by, fx.ids.sifat, 'actor from session, never client');
    assert.ok(new Date(row.reopened_at).getFullYear() > 2000, 'timestamp server-derived');
    assert.equal(String(row.closed_at), String(originalClosedAt), 'original closed_at preserved');
    assert.equal(row.closed_by, originalClosedBy, 'original closed_by preserved');

    const audit = await db('audit_logs')
      .where({ action: 'JOB_REOPENED', entity_type: 'job', entity_id: String(jobMain.jobId) })
      .first();
    assert.ok(audit && audit.user_id === fx.ids.sifat);
  });

  await test('reopen changed nothing else: signature, STOP history, photos, measurements intact', async () => {
    assert.ok(await db('customer_signatures').where({ job_id: jobMain.jobId }).first(), 'signature preserved');
    assert.equal((await db('stop_approvals').where({ job_id: jobMain.jobId })).length, 1, 'STOP history preserved');
    assert.equal((await db('job_photos').where({ job_id: jobMain.jobId })).length, 2, 'photos preserved');
    const values = await db('step_measurements')
      .join('job_steps', 'job_steps.id', 'step_measurements.job_step_id')
      .join('job_checklists', 'job_checklists.id', 'job_steps.job_checklist_id')
      .where('job_checklists.job_id', jobMain.jobId);
    assert.equal(values.length, 1);
    assert.equal(Number(values[0].value), 15, 'measurements preserved');
  });

  await test('quality inspection is read-only: SIFAT cannot mutate operational data', async () => {
    assert.equal((await http('POST', `/api/v1/jobs/${jobMain.jobId}/checklist/steps/${jobMain.steps[0].id}/complete`, { cookie: sifatCookie, body: {} })).status, 403);
    assert.equal((await uploadFile(photosPath(jobMain.jobId, jobMain.steps[1].id), 'photo', PNG_BYTES, sifatCookie)).status, 403);
    assert.equal((await http('POST', `/api/v1/jobs/${jobMain.jobId}/checklist/steps/${jobMain.steps[1].id}/redo`, { cookie: sifatCookie })).status, 403);
    assert.equal((await http('POST', `/api/v1/jobs/${jobMain.jobId}/stop/approve`, { cookie: sifatCookie })).status, 403);
    // SIFAT lacks checklist.execute → cannot upload a signature either.
    assert.equal((await uploadFile(`/api/v1/jobs/${jobMain.jobId}/signature`, 'signature', PNG_BYTES, sifatCookie)).status, 403);
    // The original (cycle-1) signature remains untouched in history.
    const origSig = await db('customer_signatures').where({ job_id: jobMain.jobId, cycle: 1 }).first();
    assert.ok(origSig && origSig.superseded_at, 'the pre-reopen signature is preserved and marked superseded');
    assert.equal((await http('PATCH', `/api/v1/jobs/${jobMain.jobId}/checklist`, { cookie: sifatCookie, body: {} })).status, 404);
  });

  // ---------------- CORRECTION (redo) ----------------

  await test('step redo: only in REOPENED jobs, opens a new attempt, clears checklist completion', async () => {
    const other = await prepareCompleted('TQC003CC');
    assert.equal(
      (await http('POST', `/api/v1/jobs/${other.jobId}/checklist/steps/${other.steps[1].id}/redo`, { cookie: ustaACookie })).status,
      409,
      'redo impossible on a COMPLETED job',
    );

    const res = await http('POST', `/api/v1/jobs/${jobMain.jobId}/checklist/steps/${jobMain.steps[1].id}/redo`, {
      cookie: ustaACookie,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const step = res.body.checklist.steps[1];
    assert.equal(step.status, 'PENDING');
    assert.equal(step.currentAttempt, 2);
    assert.equal(step.isCurrent, true);
    assert.equal(res.body.checklist.completedAt, null, 'checklist completion cleared during correction');

    const audit = await db('audit_logs')
      .where({ action: 'STEP_CORRECTION_STARTED', entity_type: 'job_step', entity_id: String(jobMain.steps[1].id) })
      .first();
    assert.ok(audit && audit.user_id === fx.ids.ustaA);
  });

  await test('re-close is gate-blocked while the correction is open', async () => {
    const res = await http('POST', `/api/v1/jobs/${jobMain.jobId}/complete`, { cookie: masterACookie });
    assert.equal(res.status, 422);
    assert.ok(res.body.error.details.some((d: any) => d.code === 'CHECKLIST_INCOMPLETE'));
  });

  await test('correction completes with fresh evidence; attempt-1 history intact', async () => {
    const noPhoto = await complete(jobMain.jobId, jobMain.steps[1].id, {
      measurements: [{ measurementId: jobMain.steps[1].measurements[0].id, value: 12 }],
    });
    assert.equal(noPhoto.status, 422, 'attempt 2 needs fresh photos');

    assert.equal((await uploadFile(photosPath(jobMain.jobId, jobMain.steps[1].id), 'photo', PNG_BYTES, ustaACookie)).status, 201);
    const res = await complete(jobMain.jobId, jobMain.steps[1].id, {
      measurements: [{ measurementId: jobMain.steps[1].measurements[0].id, value: 12 }],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const values = await db('step_measurements').where({ job_step_id: jobMain.steps[1].id }).orderBy('attempt');
    assert.deepEqual(values.map((v: any) => [v.attempt, Number(v.value)]), [[1, 15], [2, 12]], 'both attempts preserved');
    const photos = await db('job_photos').where({ job_step_id: jobMain.steps[1].id });
    assert.equal(photos.length, 2, 'attempt-1 photo preserved alongside the new one');
  });

  // ---------------- RE-CLOSE → QUALITY_REVIEW → COMPLETED ----------------

  await test('Master re-close sends the corrected job to QUALITY_REVIEW (original completion untouched)', async () => {
    assert.equal((await http('POST', `/api/v1/jobs/${jobMain.jobId}/complete`, { cookie: ustaACookie })).status, 403);
    assert.equal((await http('POST', `/api/v1/jobs/${jobMain.jobId}/complete`, { cookie: masterBCookie })).status, 404);

    // Phase 10B: the corrected work must be re-signed (the pre-reopen signature
    // was superseded when the cycle advanced) before the gate allows re-close.
    const beforeSig = await http('POST', `/api/v1/jobs/${jobMain.jobId}/complete`, { cookie: masterACookie });
    assert.equal(beforeSig.status, 422, 'a fresh signature is required after reopen');
    assert.ok(beforeSig.body.error.details.some((d: any) => d.code === 'CUSTOMER_SIGNATURE_REQUIRED'));
    assert.equal((await uploadFile(`/api/v1/jobs/${jobMain.jobId}/signature`, 'signature', PNG_BYTES, ustaACookie)).status, 201);

    const res = await http('POST', `/api/v1/jobs/${jobMain.jobId}/complete`, { cookie: masterACookie });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.job.status, 'QUALITY_REVIEW');

    const row = await db('jobs').where({ id: jobMain.jobId }).first();
    assert.equal(row.status, 'QUALITY_REVIEW');
    assert.equal(String(row.closed_at), String(originalClosedAt), 'closed_at still the ORIGINAL completion');
    assert.equal(row.closed_by, originalClosedBy);

    const audit = await db('audit_logs')
      .where({ action: 'QUALITY_REVIEW_REQUESTED', entity_type: 'job', entity_id: String(jobMain.jobId) })
      .first();
    assert.ok(audit && audit.user_id === fx.ids.masterA);

    assert.equal(
      (await http('POST', `/api/v1/jobs/${jobMain.jobId}/reopen`, { cookie: sifatCookie, body: { reason: 'yana sinov' } })).status,
      409,
      'QUALITY_REVIEW jobs are not reopenable (only COMPLETED)',
    );
  });

  await test('quality confirm completes the job a second time; both completions in audit history', async () => {
    assert.equal((await http('POST', `/api/v1/jobs/${jobMain.jobId}/quality/confirm`, { cookie: ustaACookie })).status, 403);
    assert.equal((await http('POST', `/api/v1/jobs/${jobMain.jobId}/quality/confirm`, { cookie: masterACookie })).status, 403);

    const res = await http('POST', `/api/v1/jobs/${jobMain.jobId}/quality/confirm`, { cookie: sifatCookie });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.job.status, 'COMPLETED');

    const row = await db('jobs').where({ id: jobMain.jobId }).first();
    assert.equal(row.status, 'COMPLETED');
    assert.equal(row.closed_by, fx.ids.sifat, 'second completion recorded on the job row');
    // >= because MySQL TIMESTAMP is 1-second precision; the second completion is
    // a strictly later operation but can land in the same wall-clock second.
    assert.ok(new Date(row.closed_at).getTime() >= new Date(originalClosedAt).getTime());

    const closes = await db('audit_logs')
      .where({ action: 'JOB_CLOSED', entity_type: 'job', entity_id: String(jobMain.jobId) })
      .orderBy('id');
    assert.equal(closes.length, 2, 'both completions preserved in audit');
    assert.equal(closes[0].user_id, originalClosedBy, 'first close audit intact');
    assert.equal(closes[1].user_id, fx.ids.sifat);
  });

  // ---------------- STOP INSIDE A REOPENED CYCLE ----------------

  await test('STOP redo inside a reopened cycle returns the job to REOPENED after approval (ADMIN reopen)', async () => {
    const job = await prepareCompleted('TQC004DD');
    assert.equal(
      (await http('POST', `/api/v1/jobs/${job.jobId}/reopen`, { cookie: adminCookie, body: { reason: 'STOP nazorati qayta tekshirilsin' } })).status,
      200,
      'ADMIN may reopen per §4',
    );

    assert.equal(
      (await http('POST', `/api/v1/jobs/${job.jobId}/checklist/steps/${job.steps[2].id}/redo`, { cookie: ustaACookie })).status,
      200,
    );
    assert.equal((await uploadFile(photosPath(job.jobId, job.steps[2].id), 'photo', PNG_BYTES, ustaACookie)).status, 201);
    assert.equal((await complete(job.jobId, job.steps[2].id)).status, 200);
    assert.equal((await db('jobs').where({ id: job.jobId }).first()).status, 'WAITING_STOP_APPROVAL');

    assert.equal((await http('POST', `/api/v1/jobs/${job.jobId}/stop/approve`, { cookie: masterACookie })).status, 200);
    assert.equal(
      (await db('jobs').where({ id: job.jobId }).first()).status,
      'REOPENED',
      'approval returns to REOPENED (not IN_PROGRESS) inside a reopen cycle',
    );

    // Re-sign the corrected work (Phase 10B) before re-close.
    assert.equal((await uploadFile(`/api/v1/jobs/${job.jobId}/signature`, 'signature', PNG_BYTES, ustaACookie)).status, 201);
    assert.equal((await http('POST', `/api/v1/jobs/${job.jobId}/complete`, { cookie: masterACookie })).status, 200);
    assert.equal((await db('jobs').where({ id: job.jobId }).first()).status, 'QUALITY_REVIEW');
    assert.equal((await http('POST', `/api/v1/jobs/${job.jobId}/quality/confirm`, { cookie: sifat2Cookie })).status, 200);
    assert.equal((await db('jobs').where({ id: job.jobId }).first()).status, 'COMPLETED');

    const stopRecords = await db('stop_approvals').where({ job_id: job.jobId }).orderBy('id');
    assert.deepEqual(stopRecords.map((r: any) => [r.attempt, r.status]), [[1, 'APPROVED'], [2, 'APPROVED']]);
  });

  // ---------------- CONCURRENCY + BYPASS ----------------

  await test('concurrent reopens: exactly one succeeds with a single audit row', async () => {
    const job = await prepareCompleted('TQC005EE');
    const [a, b] = await Promise.all([
      http('POST', `/api/v1/jobs/${job.jobId}/reopen`, { cookie: sifatCookie, body: { reason: 'birinchi sifat xodimi' } }),
      http('POST', `/api/v1/jobs/${job.jobId}/reopen`, { cookie: sifat2Cookie, body: { reason: 'ikkinchi sifat xodimi' } }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409], `got ${a.status}/${b.status}`);
    const row = await db('jobs').where({ id: job.jobId }).first();
    assert.equal(row.status, 'REOPENED');
    const audits = await db('audit_logs')
      .where({ action: 'JOB_REOPENED', entity_type: 'job', entity_id: String(job.jobId) })
      .count({ c: '*' });
    assert.equal(Number((audits as any)[0].c), 1);

    // Re-sign so the re-close gate is valid, then race reopen vs re-close.
    assert.equal((await uploadFile(`/api/v1/jobs/${job.jobId}/signature`, 'signature', PNG_BYTES, ustaACookie)).status, 201);
    const [close, reopen] = await Promise.all([
      http('POST', `/api/v1/jobs/${job.jobId}/complete`, { cookie: masterACookie }),
      http('POST', `/api/v1/jobs/${job.jobId}/reopen`, { cookie: sifatCookie, body: { reason: 'poyga sinovi' } }),
    ]);
    assert.equal(close.status, 200, 'the re-close should pass (gate valid)');
    assert.equal(reopen.status, 409, 'reopen only ever works from COMPLETED');
    assert.equal((await db('jobs').where({ id: job.jobId }).first()).status, 'QUALITY_REVIEW');
  });

  await test('no generic status surface can bypass the quality workflow', async () => {
    assert.equal(
      (await http('PATCH', `/api/v1/jobs/${jobMain.jobId}`, { cookie: adminCookie, body: { status: 'REOPENED' } })).status,
      404,
    );
    assert.equal(
      (await http('PATCH', `/api/v1/jobs/${jobMain.jobId}/quality`, { cookie: sifatCookie, body: { status: 'COMPLETED' } })).status,
      404,
    );
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
