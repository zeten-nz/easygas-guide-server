/**
 * EASY GAS — Phase 10B evidence & storage integrity E2E tests.
 *
 *   npm run test:evidence   (after: npm run test:setup)
 *
 * Uses a controllable in-memory storage provider (injected via
 * setStorageProviderForTesting) with failure/barrier hooks so the two-phase
 * upload state machine and its failure modes are exercised deterministically
 * (no sleeps). Covers the concurrency/failure matrix in the Phase 10B brief.
 *
 * Fixtures: users +99899000870x, "TEST EV ..." names, TEV* plates.
 */
import { assertTestDatabase } from './helpers/test-env';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import { db } from '../src/config/database';
import { createApp } from '../src/app';
import { csrfTokenFor } from '../src/middleware/csrf.middleware';
import { setSmsProviderForTesting } from '../src/sms';
import { setStorageProviderForTesting } from '../src/storage';
import { StorageError } from '../src/storage/storage.provider';
import { MemoryStorageProvider } from './helpers/memory-storage';
import { reconcileEvidence } from '../src/modules/evidence/reconcile.service';

const USERS = {
  admin: '+998990008701',
  ustaA: '+998990008702',
  masterA: '+998990008703',
  ustaB: '+998990008704',
};
const PASSWORD = 'Sinov-parol-123';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
// A tiny but valid 2x2 red PNG (distinct bytes) for a second image.
const PNG2 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mP8z8BQz0AEYBxVSF8FAGnHBPvOgYY9AAAAAElFTkSuQmCC',
  'base64',
);
const TEXT = Buffer.from('not an image, plain text, wrong magic bytes');

let baseUrl = '';
let storage: MemoryStorageProvider;

interface HttpResult {
  status: number;
  body: any;
  setCookies: string[];
}
async function http(method: string, p: string, opts: { body?: unknown; cookie?: string } = {}): Promise<HttpResult> {
  const res = await fetch(`${baseUrl}${p}`, {
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
async function upload(p: string, bytes: Buffer, cookie: string, filename = 'f.png'): Promise<HttpResult> {
  const form = new FormData();
  form.append('photo', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), filename);
  const res = await fetch(`${baseUrl}${p}`, {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': csrfTokenFor(cookie.split('=')[1] ?? '') },
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
async function uploadSig(jobId: number, bytes: Buffer, cookie: string): Promise<HttpResult> {
  const form = new FormData();
  form.append('signature', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), 'sig.png');
  const res = await fetch(`${baseUrl}/api/v1/jobs/${jobId}/signature`, {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': csrfTokenFor(cookie.split('=')[1] ?? '') },
    body: form,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, setCookies: [] };
}
async function login(phone: string): Promise<string> {
  const res = await http('POST', '/api/v1/auth/login', { body: { phone, password: PASSWORD, rememberMe: false } });
  assert.equal(res.status, 200, `login ${phone}`);
  return res.setCookies.find((c) => c.startsWith('eg_session='))!.split(';')[0];
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

async function cleanup(): Promise<void> {
  const jobIds = (
    await db('jobs').join('vehicles', 'vehicles.id', 'jobs.vehicle_id').where('vehicles.plate_number', 'like', 'TEV%').select('jobs.id')
  ).map((j: { id: number }) => j.id);
  if (jobIds.length > 0) {
    await db('customer_signatures').whereIn('job_id', jobIds).del();
    await db('job_photos').whereIn('job_id', jobIds).del();
    const apprIds = (await db('stop_approvals').whereIn('job_id', jobIds).select('id')).map((a: { id: number }) => a.id);
    if (apprIds.length > 0) {
      await db('audit_logs').where('entity_type', 'stop_approval').whereIn('entity_id', apprIds.map(String)).del();
    }
    await db('stop_approvals').whereIn('job_id', jobIds).del();
    const clIds = (await db('job_checklists').whereIn('job_id', jobIds).select('id')).map((c: { id: number }) => c.id);
    if (clIds.length > 0) {
      const stepIds = (await db('job_steps').whereIn('job_checklist_id', clIds).select('id')).map((s: { id: number }) => s.id);
      if (stepIds.length > 0) {
        await db('step_measurements').whereIn('job_step_id', stepIds).del();
        await db('audit_logs').where('entity_type', 'job_step').whereIn('entity_id', stepIds.map(String)).del();
        await db('job_steps').whereIn('id', stepIds).del();
      }
      await db('job_checklists').whereIn('id', clIds).del();
    }
    await db('audit_logs').whereIn('entity_type', ['job', 'job_photo']).whereIn('entity_id', jobIds.map(String)).del();
    await db('jobs').whereIn('id', jobIds).del();
  }
  const tplIds = (await db('checklist_templates').where('name', 'like', 'TEST EV%').select('id')).map((t: { id: number }) => t.id);
  if (tplIds.length > 0) {
    const vIds = (await db('checklist_template_versions').whereIn('template_id', tplIds).select('id')).map((v: { id: number }) => v.id);
    if (vIds.length > 0) {
      const sIds = (await db('checklist_steps').whereIn('version_id', vIds).select('id')).map((s: { id: number }) => s.id);
      if (sIds.length > 0) {
        await db('checklist_step_measurements').whereIn('step_id', sIds).del();
        await db('checklist_steps').whereIn('id', sIds).del();
      }
      await db('checklist_template_versions').whereIn('id', vIds).del();
    }
    await db('checklist_templates').whereIn('id', tplIds).del();
  }
  const custIds = (await db('customers').where('name', 'like', 'TEST EV%').select('id')).map((c: { id: number }) => c.id);
  await db('vehicles').where('plate_number', 'like', 'TEV%').del();
  if (custIds.length > 0) await db('customers').whereIn('id', custIds).del();
  const users = await db('users').whereIn('phone', Object.values(USERS)).select('id');
  const uids = users.map((u: { id: number }) => u.id);
  if (uids.length > 0) {
    await db('audit_logs').whereIn('user_id', uids).del();
    await db('sessions').whereIn('user_id', uids).del();
  }
  await db('users').whereIn('phone', Object.values(USERS)).del();
  await db('branches').where('name', 'like', 'TEST EV%').del();
}

async function run(): Promise<void> {
  setSmsProviderForTesting({ name: 'test-capture', send: async () => {} });
  storage = new MemoryStorageProvider();
  setStorageProviderForTesting(storage);
  await assertTestDatabase(db);
  await cleanup();

  const roles = await db('roles').select('id', 'code');
  const roleId = (c: string) => roles.find((r: { code: string }) => r.code === c)?.id;
  const [branchA] = await db('branches').insert({ name: 'TEST EV Branch A', region: 'Toshkent shahri', status: 'ACTIVE' });
  const [branchB] = await db('branches').insert({ name: 'TEST EV Branch B', region: 'Samarqand', status: 'ACTIVE' });
  const pw = await bcrypt.hash(PASSWORD, 10);
  const base = { password_hash: pw, region: 'Toshkent shahri', status: 'ACTIVE' };
  const ins = async (r: Record<string, unknown>) => (await db('users').insert(r))[0] as number;
  const ids: Record<string, number> = {};
  ids.admin = await ins({ ...base, first_name: 'Ev', last_name: 'Admin', phone: USERS.admin, branch_id: null, role_id: roleId('ADMIN') });
  ids.ustaA = await ins({ ...base, first_name: 'Ev', last_name: 'UstaA', phone: USERS.ustaA, branch_id: branchA, role_id: roleId('USTA') });
  ids.masterA = await ins({ ...base, first_name: 'Ev', last_name: 'MasterA', phone: USERS.masterA, branch_id: branchA, role_id: roleId('MASTER') });
  ids.ustaB = await ins({ ...base, first_name: 'Ev', last_name: 'UstaB', phone: USERS.ustaB, branch_id: branchB, role_id: roleId('USTA') });

  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  console.log(`\nRunning evidence E2E against ${baseUrl}\n`);

  const usta = await login(USERS.ustaA);
  const ustaB = await login(USERS.ustaB);
  const master = await login(USERS.masterA);
  const admin = await login(USERS.admin);

  const c = await http('POST', '/api/v1/customers', { cookie: usta, body: { name: 'TEST EV Mijoz', phone: '99 000 87 11' } });
  const customerId = c.body.customer.id as number;
  // Template: s1 plain, s2 measurement + 1 photo, s3 STOP + 1 photo
  const t = await http('POST', '/api/v1/checklist-templates', { cookie: admin, body: { name: 'TEST EV Shablon' } });
  const templateId = t.body.template.id;
  const versionId = t.body.template.versions[0].id;
  for (const step of [
    { name: 'Tayyorgarlik' },
    { name: "O'lchov", requiredPhotos: 1, measurements: [{ name: 'Bosim', unit: 'bar', minValue: 10, maxValue: 20, required: true }] },
    { name: 'STOP', isStop: true, requiredPhotos: 1 },
  ]) {
    await http('POST', `/api/v1/checklist-templates/${templateId}/versions/${versionId}/steps`, { cookie: admin, body: step });
  }
  await http('POST', `/api/v1/checklist-templates/${templateId}/versions/${versionId}/publish`, { cookie: admin });

  const mkJob = async (plate: string) => {
    const v = await http('POST', '/api/v1/vehicles', { cookie: usta, body: { customerId, plateNumber: plate, make: 'Chevrolet', model: 'Spark' } });
    const j = await http('POST', '/api/v1/jobs', { cookie: usta, body: { customerId, vehicleId: v.body.vehicle.id } });
    const jobId = j.body.job.id as number;
    await http('POST', `/api/v1/jobs/${jobId}/start`, { cookie: usta });
    const a = await http('POST', `/api/v1/jobs/${jobId}/checklist`, { cookie: usta, body: { templateId } });
    return { jobId, steps: a.body.checklist.steps as any[] };
  };
  const stepPath = (jobId: number, stepId: number) => `/api/v1/jobs/${jobId}/checklist/steps/${stepId}/photos`;
  const complete = (jobId: number, stepId: number, body: any = {}) => http('POST', `/api/v1/jobs/${jobId}/checklist/steps/${stepId}/complete`, { cookie: usta, body });

  // ---- Happy path + READY semantics ----
  await test('successful photo upload becomes READY with a stored object + READY audit', async () => {
    const job = await mkJob('TEV001AA');
    const res = await upload(stepPath(job.jobId, job.steps[1].id), PNG, usta);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const row = await db('job_photos').where({ id: res.body.photo.id }).first();
    assert.equal(row.status, 'READY');
    assert.ok(row.ready_at);
    assert.equal(storage.has(row.storage_key), true, 'object exists in storage');
    const started = await db('audit_logs').where({ action: 'PHOTO_UPLOAD_STARTED', entity_id: String(row.id) }).first();
    const ready = await db('audit_logs').where({ action: 'PHOTO_UPLOAD_READY', entity_id: String(row.id) }).first();
    assert.ok(started && ready, 'STARTED and READY both audited');
  });

  // ---- 13. PENDING / FAILED do not satisfy the required-photo gate ----
  await test('a non-READY photo does not satisfy the required-photo gate', async () => {
    const job = await mkJob('TEV002BB');
    await complete(job.jobId, job.steps[0].id);
    const up = await upload(stepPath(job.jobId, job.steps[1].id), PNG, usta);
    assert.equal(up.status, 201);
    const mId = job.steps[1].measurements[0].id;
    // Demote the READY photo to PENDING → it must stop counting as evidence.
    await db('job_photos').where({ id: up.body.photo.id }).update({ status: 'PENDING', ready_at: null });
    const blocked = await complete(job.jobId, job.steps[1].id, { measurements: [{ measurementId: mId, value: 15 }] });
    assert.equal(blocked.status, 422, `PENDING gate: got ${blocked.status} ${JSON.stringify(blocked.body)}`);
    assert.ok(blocked.body.error.code === 'PHOTOS_REQUIRED');
    // Restore to READY → completion proceeds.
    await db('job_photos').where({ id: up.body.photo.id }).update({ status: 'READY', ready_at: db.fn.now() });
    assert.equal((await complete(job.jobId, job.steps[1].id, { measurements: [{ measurementId: mId, value: 15 }] })).status, 200);
  });

  // ---- 2. Storage write failure ----
  await test('storage write failure leaves a FAILED row, no valid evidence, 502', async () => {
    const job = await mkJob('TEV003CC');
    await complete(job.jobId, job.steps[0].id);
    storage.failNextPut = new StorageError('IO', 'disk full');
    const res = await upload(stepPath(job.jobId, job.steps[1].id), PNG, usta);
    assert.equal(res.status, 502);
    const rows = await db('job_photos').where({ job_step_id: job.steps[1].id });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'FAILED');
    assert.equal(rows[0].failure_reason, 'STORAGE_IO');
    const readyCount = (await db('job_photos').where({ job_step_id: job.steps[1].id, status: 'READY' })).length;
    assert.equal(readyCount, 0, 'no READY evidence after a storage failure');
    const failedAudit = await db('audit_logs').where({ action: 'PHOTO_UPLOAD_FAILED', entity_id: String(rows[0].id) }).first();
    assert.ok(failedAudit);
  });

  // ---- 11. Size mismatch on verify ----
  await test('stored-size mismatch after put fails the upload (no READY)', async () => {
    const job = await mkJob('TEV004DD');
    await complete(job.jobId, job.steps[0].id);
    // afterPut mutates the stored object so stat() reports a different size.
    storage.afterPut = async (key) => {
      (storage as any).objects.set(key, { data: Buffer.concat([PNG, Buffer.from('x')]) });
    };
    const res = await upload(stepPath(job.jobId, job.steps[1].id), PNG, usta);
    storage.afterPut = null;
    assert.equal(res.status, 502, 'a size mismatch must not produce READY evidence');
    const readyCount = (await db('job_photos').where({ job_step_id: job.steps[1].id, status: 'READY' })).length;
    assert.equal(readyCount, 0);
  });

  // ---- 6. Step moves on during upload (finalize supersede + object cleanup) ----
  await test('a step completed between PUT and finalize supersedes the in-flight upload (FAILED, object cleaned)', async () => {
    // Uploads only ever start on a PENDING step; if the step leaves PENDING (or
    // its attempt changes) while an upload is between PUT and finalize, the
    // finalize must refuse to mark READY, mark FAILED(SUPERSEDED) and delete the
    // orphan object. Use step[0] (no required photos) so it can be completed
    // while the parked upload is in flight.
    const job = await mkJob('TEV005EE');
    let release: () => void = () => {};
    storage.putBarrier = new Promise<void>((r) => (release = r));
    const entered = new Promise<void>((r) => (storage.onPutEnter = r));
    const uploadPromise = upload(stepPath(job.jobId, job.steps[0].id), PNG, usta);
    await entered; // TX1 committed (PENDING registered), upload now parked at the barrier
    // Complete step[0] while the upload is parked at the storage barrier.
    assert.equal((await complete(job.jobId, job.steps[0].id)).status, 200);
    release();
    const res = await uploadPromise;
    storage.putBarrier = null;
    assert.equal(res.status, 409, `supersede: got ${res.status} ${JSON.stringify(res.body)}`);
    const superseded = await db('job_photos').where({ job_step_id: job.steps[0].id }).orderBy('id', 'desc').first();
    assert.equal(superseded.status, 'FAILED');
    assert.equal(superseded.failure_reason, 'SUPERSEDED');
    assert.equal(storage.has(superseded.storage_key), false, 'the orphan object was cleaned up');
  });

  // ---- 5. Job cancellation during upload ----
  await test('job cancelled between PUT and finalize → upload superseded, no READY', async () => {
    const job = await mkJob('TEV006FF');
    await complete(job.jobId, job.steps[0].id);
    let release: () => void = () => {};
    storage.putBarrier = new Promise<void>((r) => (release = r));
    const entered = new Promise<void>((r) => (storage.onPutEnter = r));
    const uploadPromise = upload(stepPath(job.jobId, job.steps[1].id), PNG, usta);
    await entered;
    await http('POST', `/api/v1/jobs/${job.jobId}/cancel`, { cookie: usta, body: { reason: 'bekor qilindi' } });
    release();
    const res = await uploadPromise;
    storage.putBarrier = null;
    assert.equal(res.status, 409);
    const readyCount = (await db('job_photos').where({ job_step_id: job.steps[1].id, status: 'READY' })).length;
    assert.equal(readyCount, 0, 'a cancelled job has no READY evidence');
  });

  // ---- 7. Two simultaneous uploads ----
  await test('two simultaneous uploads both become READY (within the per-attempt limit)', async () => {
    const job = await mkJob('TEV007GG');
    await complete(job.jobId, job.steps[0].id);
    const [a, b] = await Promise.all([
      upload(stepPath(job.jobId, job.steps[1].id), PNG, usta),
      upload(stepPath(job.jobId, job.steps[1].id), PNG2, usta),
    ]);
    assert.equal(a.status, 201, `a: ${JSON.stringify(a.body)}`);
    assert.equal(b.status, 201, `b: ${JSON.stringify(b.body)}`);
    const ready = await db('job_photos').where({ job_step_id: job.steps[1].id, status: 'READY' });
    assert.equal(ready.length, 2);
  });

  // ---- 16. Path traversal / fake type / oversize / high-dimension ----
  await test('fake, malformed, and oversized files are rejected before any storage write', async () => {
    const job = await mkJob('TEV008HH');
    await complete(job.jobId, job.steps[0].id);
    const beforeObjs = storage.size;
    assert.equal((await upload(stepPath(job.jobId, job.steps[1].id), TEXT, usta)).body.error.code, 'INVALID_FILE_TYPE');
    // A PNG header claiming 20000x20000 pixels → IMAGE_TOO_LARGE.
    const bomb = Buffer.from(PNG);
    bomb.writeUInt32BE(20000, 16);
    bomb.writeUInt32BE(20000, 20);
    assert.equal((await upload(stepPath(job.jobId, job.steps[1].id), bomb, usta)).body.error.code, 'IMAGE_TOO_LARGE');
    assert.equal(storage.size, beforeObjs, 'no object written for rejected uploads');
  });

  // ---- 15. Cross-branch upload access ----
  await test('cross-branch photo upload and file read are rejected (404)', async () => {
    const job = await mkJob('TEV009II');
    await complete(job.jobId, job.steps[0].id);
    const mine = await upload(stepPath(job.jobId, job.steps[1].id), PNG, usta);
    assert.equal(mine.status, 201);
    assert.equal((await upload(stepPath(job.jobId, job.steps[1].id), PNG, ustaB)).status, 404);
    const fileRes = await fetch(`${baseUrl}${stepPath(job.jobId, job.steps[1].id)}/${mine.body.photo.id}/file`, { headers: { cookie: ustaB } });
    assert.equal(fileRes.status, 404);
  });

  // ---- Download streaming + safe headers ----
  await test('photo file download streams exact bytes with safe headers', async () => {
    const job = await mkJob('TEV010JJ');
    await complete(job.jobId, job.steps[0].id);
    const up = await upload(stepPath(job.jobId, job.steps[1].id), PNG, usta);
    const fileRes = await fetch(`${baseUrl}${stepPath(job.jobId, job.steps[1].id)}/${up.body.photo.id}/file`, { headers: { cookie: usta } });
    assert.equal(fileRes.status, 200);
    assert.equal(fileRes.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(fileRes.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await fileRes.arrayBuffer());
    assert.ok(bytes.equals(PNG), 'streamed bytes match the upload');
  });

  // ---- 10. Missing READY object detected by completion? (defense) + reconciliation ----
  await test('reconciliation dry-run detects a missing READY object and does NOT modify data', async () => {
    const job = await mkJob('TEV011KK');
    await complete(job.jobId, job.steps[0].id);
    const up = await upload(stepPath(job.jobId, job.steps[1].id), PNG, usta);
    const photo = await db('job_photos').where({ id: up.body.photo.id }).first();
    // Simulate object loss (bit rot / accidental deletion) without touching the DB.
    await storage.delete(photo.storage_key);

    const dry = await reconcileEvidence({ fix: false });
    assert.equal(dry.dryRun, true);
    assert.ok(dry.findings.some((f) => f.kind === 'MISSING' && f.id === photo.id), 'missing object detected');
    const after = await db('job_photos').where({ id: photo.id }).first();
    assert.equal(after.status, 'READY', 'dry-run must not mutate the row');
  });

  await test('reconciliation --fix marks the missing READY object FAILED and audits it', async () => {
    // Identify READY photo rows whose object is actually absent from storage.
    const readyRows = await db('job_photos').where({ status: 'READY' }).select('id', 'storage_key');
    const missing: number[] = [];
    for (const r of readyRows) if (!storage.has(r.storage_key)) missing.push(r.id);
    assert.ok(missing.length >= 1, 'at least one READY row has a missing object');

    const fixed = await reconcileEvidence({ fix: true });
    assert.ok(fixed.fixed >= 1, 'at least one row fixed');
    for (const id of missing) {
      const row = await db('job_photos').where({ id }).first();
      assert.equal(row.status, 'FAILED', `photo ${id} marked FAILED`);
      assert.equal(row.failure_reason, 'MISSING_OBJECT');
    }
    const audit = await db('audit_logs').where({ action: 'EVIDENCE_INTEGRITY_FAILURE' }).first();
    assert.ok(audit, 'integrity failure audited');
  });

  // ---- 8/9. Signature racing completion + reopen invalidation (via completion suite already,
  //          here we assert the storage-integrity angle) ----
  await test('signature upload failure leaves no valid signature (FAILED, 502)', async () => {
    const job = await mkJob('TEV012LL');
    // drive to a completed checklist
    await complete(job.jobId, job.steps[0].id);
    await upload(stepPath(job.jobId, job.steps[1].id), PNG, usta);
    await complete(job.jobId, job.steps[1].id, { measurements: [{ measurementId: job.steps[1].measurements[0].id, value: 15 }] });
    await upload(stepPath(job.jobId, job.steps[2].id), PNG, usta);
    await complete(job.jobId, job.steps[2].id);
    await http('POST', `/api/v1/jobs/${job.jobId}/stop/approve`, { cookie: master });

    storage.failNextPut = new StorageError('TIMEOUT', 'gone');
    const sig = await uploadSig(job.jobId, PNG, usta);
    assert.equal(sig.status, 502);
    const rows = await db('customer_signatures').where({ job_id: job.jobId });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'FAILED');
    // The job cannot be closed with only a FAILED signature.
    const close = await http('POST', `/api/v1/jobs/${job.jobId}/complete`, { cookie: master });
    assert.equal(close.status, 422);
    assert.ok(close.body.error.details.some((d: any) => d.code === 'CUSTOMER_SIGNATURE_REQUIRED'));

    // A retry then succeeds → READY → closes.
    const retry = await uploadSig(job.jobId, PNG, usta);
    assert.equal(retry.status, 201);
    assert.equal((await http('POST', `/api/v1/jobs/${job.jobId}/complete`, { cookie: master })).status, 200);
  });

  // Drives a job to "checklist done + STOP approved" — ready except the signature.
  const driveToSignable = async (job: { jobId: number; steps: any[] }) => {
    await complete(job.jobId, job.steps[0].id);
    await upload(stepPath(job.jobId, job.steps[1].id), PNG, usta);
    await complete(job.jobId, job.steps[1].id, { measurements: [{ measurementId: job.steps[1].measurements[0].id, value: 15 }] });
    await upload(stepPath(job.jobId, job.steps[2].id), PNG, usta);
    await complete(job.jobId, job.steps[2].id);
    await http('POST', `/api/v1/jobs/${job.jobId}/stop/approve`, { cookie: master });
  };

  // ---- 9. Object deleted after READY → completion fails closed ----
  await test('object lost after READY makes job completion fail closed (502), status unchanged, no silent FAILED', async () => {
    const job = await mkJob('TEV013MM');
    await driveToSignable(job);
    assert.equal((await uploadSig(job.jobId, PNG, usta)).status, 201);
    // Externally lose a required READY photo object (bit rot / accidental delete).
    const photo = await db('job_photos').where({ job_step_id: job.steps[1].id, status: 'READY' }).first();
    await storage.delete(photo.storage_key);
    const close = await http('POST', `/api/v1/jobs/${job.jobId}/complete`, { cookie: master });
    assert.equal(close.status, 502, JSON.stringify(close.body));
    assert.equal(close.body.error.code, 'EVIDENCE_UNVERIFIABLE');
    assert.notEqual((await db('jobs').where({ id: job.jobId }).first()).status, 'COMPLETED');
    // The completion read must NOT have mutated the row to FAILED.
    assert.equal((await db('job_photos').where({ id: photo.id }).first()).status, 'READY');
  });

  // ---- 10. Storage stat timeout during completion → fails closed ----
  await test('a storage stat timeout during completion fails closed (502); clearing it lets the close succeed', async () => {
    const job = await mkJob('TEV014NN');
    await driveToSignable(job);
    assert.equal((await uploadSig(job.jobId, PNG, usta)).status, 201);
    const sigRow = await db('customer_signatures').where({ job_id: job.jobId, status: 'READY' }).first();
    storage.statOverride.set(sigRow.storage_key, new StorageError('TIMEOUT', 'gone'));
    const blocked = await http('POST', `/api/v1/jobs/${job.jobId}/complete`, { cookie: master });
    assert.equal(blocked.status, 502);
    assert.equal(blocked.body.error.code, 'EVIDENCE_UNVERIFIABLE');
    storage.statOverride.delete(sigRow.storage_key);
    assert.equal((await http('POST', `/api/v1/jobs/${job.jobId}/complete`, { cookie: master })).status, 200);
  });

  // ---- 11. Reopened job still requires a current-cycle READY signature ----
  await test('after reopen the old signature is superseded and a fresh current-cycle signature is required', async () => {
    const job = await mkJob('TEV015OO');
    await driveToSignable(job);
    assert.equal((await uploadSig(job.jobId, PNG, usta)).status, 201);
    assert.equal((await http('POST', `/api/v1/jobs/${job.jobId}/complete`, { cookie: master })).status, 200); // COMPLETED cycle 1
    const reopen = await http('POST', `/api/v1/jobs/${job.jobId}/reopen`, { cookie: admin, body: { reason: 'qayta korib chiqish kerak' } });
    assert.equal(reopen.status, 200, JSON.stringify(reopen.body));
    assert.equal((await db('jobs').where({ id: job.jobId }).first()).cycle, 2);
    assert.ok((await db('customer_signatures').where({ job_id: job.jobId, cycle: 1 }).first()).superseded_at, 'cycle-1 signature superseded, not deleted');
    // Re-close is blocked without a cycle-2 signature (the old one no longer authorizes).
    const blocked = await http('POST', `/api/v1/jobs/${job.jobId}/complete`, { cookie: master });
    assert.equal(blocked.status, 422);
    assert.ok(blocked.body.error.details.some((d: any) => d.code === 'CUSTOMER_SIGNATURE_REQUIRED'));
    // Fresh cycle-2 signature → close proceeds to QUALITY_REVIEW.
    assert.equal((await uploadSig(job.jobId, PNG, usta)).status, 201);
    assert.equal((await http('POST', `/api/v1/jobs/${job.jobId}/complete`, { cookie: master })).status, 200);
    assert.equal((await db('jobs').where({ id: job.jobId }).first()).status, 'QUALITY_REVIEW');
  });

  // ---- 12. Failed legacy evidence never satisfies a completion gate ----
  await test('a FAILED (integrity-invalidated) signature never satisfies completion', async () => {
    const job = await mkJob('TEV016PP');
    await driveToSignable(job);
    const jobRow = await db('jobs').where({ id: job.jobId }).first();
    // A signature that reconciliation would have marked FAILED (e.g. hash mismatch).
    await db('customer_signatures').insert({
      job_id: job.jobId, customer_id: jobRow.customer_id, cycle: jobRow.cycle, status: 'FAILED',
      storage_key: `signatures/${job.jobId}/legacy-bad-${Date.now()}.png`, mime_type: 'image/png',
      content_type: 'image/png', size_bytes: PNG.length, hash: 'deadbeef',
      failure_reason: 'LEGACY_HASH_MISMATCH', failed_at: db.fn.now(),
    });
    const blocked = await http('POST', `/api/v1/jobs/${job.jobId}/complete`, { cookie: master });
    assert.equal(blocked.status, 422);
    assert.ok(blocked.body.error.details.some((d: any) => d.code === 'CUSTOMER_SIGNATURE_REQUIRED'), JSON.stringify(blocked.body));
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
