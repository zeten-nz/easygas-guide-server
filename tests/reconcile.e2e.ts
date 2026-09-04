/**
 * EASY GAS — Phase 10B legacy evidence reconciliation E2E tests.
 *
 *   npm run test:reconcile   (after: npm run test:setup)
 *
 * Legacy (pre-Phase-10B) rows are backfilled to UNVERIFIED and must NEVER become
 * READY merely because a DB row exists. Only a successful DEEP verification
 * (object read, sha256 recomputed, size + hash + type matched) may promote
 * UNVERIFIED -> READY; a missing/altered object becomes FAILED. These tests
 * exercise dry-run vs apply, deep-hash detection, idempotency, resumability and
 * the "new READY evidence is not treated as legacy" guarantee — all against a
 * controllable in-memory store (no sleeps).
 *
 * Fixtures: users +99899000881x, "TEST RC ..." names, TRC* plates.
 */
import { assertTestDatabase } from './helpers/test-env';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { db } from '../src/config/database';
import { createApp } from '../src/app';
import { csrfTokenFor } from '../src/middleware/csrf.middleware';
import { setSmsProviderForTesting } from '../src/sms';
import { setStorageProviderForTesting } from '../src/storage';
import { StorageError } from '../src/storage/storage.provider';
import { MemoryStorageProvider } from './helpers/memory-storage';
import { reconcileEvidence } from '../src/modules/evidence/reconcile.service';

const USERS = { admin: '+998990008811', usta: '+998990008812', master: '+998990008813' };
const PASSWORD = 'Sinov-parol-123';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let baseUrl = '';
let storage: MemoryStorageProvider;

interface HttpResult { status: number; body: any; setCookies: string[] }
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
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, setCookies: res.headers.getSetCookie() };
}
async function upload(p: string, bytes: Buffer, cookie: string): Promise<HttpResult> {
  const form = new FormData();
  form.append('photo', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), 'f.png');
  const res = await fetch(`${baseUrl}${p}`, {
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
  try { await fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (err) { failed += 1; console.error(`  FAIL  ${name}`); console.error(`        ${err instanceof Error ? err.stack : String(err)}`); }
}

let ustaId = 0;
async function cleanup(): Promise<void> {
  const jobIds = (
    await db('jobs').join('vehicles', 'vehicles.id', 'jobs.vehicle_id').where('vehicles.plate_number', 'like', 'TRC%').select('jobs.id')
  ).map((j: { id: number }) => j.id);
  if (jobIds.length > 0) {
    await db('customer_signatures').whereIn('job_id', jobIds).del();
    await db('job_photos').whereIn('job_id', jobIds).del();
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
  const tplIds = (await db('checklist_templates').where('name', 'like', 'TEST RC%').select('id')).map((t: { id: number }) => t.id);
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
  const custIds = (await db('customers').where('name', 'like', 'TEST RC%').select('id')).map((c: { id: number }) => c.id);
  await db('vehicles').where('plate_number', 'like', 'TRC%').del();
  if (custIds.length > 0) await db('customers').whereIn('id', custIds).del();
  const users = await db('users').whereIn('phone', Object.values(USERS)).select('id');
  const uids = users.map((u: { id: number }) => u.id);
  if (uids.length > 0) {
    await db('audit_logs').whereIn('user_id', uids).del();
    await db('sessions').whereIn('user_id', uids).del();
  }
  await db('users').whereIn('phone', Object.values(USERS)).del();
  await db('branches').where('name', 'like', 'TEST RC%').del();
}

/** Inserts a legacy (UNVERIFIED) photo row and optionally places its object. */
async function legacyPhoto(
  jobId: number,
  stepId: number,
  place: 'match' | 'corrupt-samesize' | 'missing',
): Promise<{ id: number; key: string; hash: string }> {
  const hash = crypto.createHash('sha256').update(PNG).digest('hex');
  const key = `photos/${jobId}/${stepId}/legacy-${crypto.randomUUID()}.png`;
  const [id] = await db('job_photos').insert({
    job_id: jobId, job_step_id: stepId, attempt: 1, status: 'UNVERIFIED',
    storage_key: key, original_name: 'legacy.png', mime_type: 'image/png',
    content_type: 'image/png', size_bytes: PNG.length, hash, created_by: ustaId,
  });
  if (place === 'match') storage.setObject(key, PNG);
  else if (place === 'corrupt-samesize') {
    const bad = Buffer.from(PNG);
    bad[bad.length - 1] ^= 0xff; // same length, different bytes -> different sha256
    storage.setObject(key, bad);
  } // 'missing' places nothing
  return { id: id as number, key, hash };
}

async function run(): Promise<void> {
  setSmsProviderForTesting({ name: 'test-capture', send: async () => ({ providerMessageId: null, outcome: 'ACCEPTED' as const }) });
  storage = new MemoryStorageProvider();
  setStorageProviderForTesting(storage);
  await assertTestDatabase(db);
  await cleanup();

  const roles = await db('roles').select('id', 'code');
  const roleId = (c: string) => roles.find((r: { code: string }) => r.code === c)?.id;
  const [branch] = await db('branches').insert({ name: 'TEST RC Branch', region: 'Toshkent shahri', status: 'ACTIVE' });
  const pw = await bcrypt.hash(PASSWORD, 10);
  const base = { password_hash: pw, region: 'Toshkent shahri', status: 'ACTIVE' };
  const ins = async (r: Record<string, unknown>) => (await db('users').insert(r))[0] as number;
  const adminId = await ins({ ...base, first_name: 'Rc', last_name: 'Admin', phone: USERS.admin, branch_id: null, role_id: roleId('ADMIN') });
  ustaId = await ins({ ...base, first_name: 'Rc', last_name: 'Usta', phone: USERS.usta, branch_id: branch, role_id: roleId('USTA') });
  await ins({ ...base, first_name: 'Rc', last_name: 'Master', phone: USERS.master, branch_id: branch, role_id: roleId('MASTER') });
  void adminId;

  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  console.log(`\nRunning reconcile E2E against ${baseUrl}\n`);

  const usta = await login(USERS.usta);
  const admin = await login(USERS.admin);

  const c = await http('POST', '/api/v1/customers', { cookie: usta, body: { name: 'TEST RC Mijoz', phone: '99 000 88 21' } });
  const customerId = c.body.customer.id as number;
  const t = await http('POST', '/api/v1/checklist-templates', { cookie: admin, body: { name: 'TEST RC Shablon' } });
  const templateId = t.body.template.id;
  const versionId = t.body.template.versions[0].id;
  for (const step of [{ name: 'Tayyorgarlik' }, { name: 'Rasm', requiredPhotos: 1 }]) {
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

  // ---- 1. Legacy existing object with correct bytes -> READY after apply ----
  await test('legacy object with correct bytes is promoted UNVERIFIED -> READY on apply --deep', async () => {
    const job = await mkJob('TRC001AA');
    const p = await legacyPhoto(job.jobId, job.steps[1].id, 'match');
    const res = await reconcileEvidence({ apply: true, deep: true });
    assert.ok(res.results.some((r) => r.id === p.id && r.kind === 'VERIFIED' && r.transitionedTo === 'READY'));
    const row = await db('job_photos').where({ id: p.id }).first();
    assert.equal(row.status, 'READY');
    assert.ok(row.ready_at, 'ready_at set on promotion');
  });

  // ---- 2. Legacy missing object -> never READY ----
  await test('legacy row with a missing object is never READY (becomes FAILED on apply)', async () => {
    const job = await mkJob('TRC002BB');
    const p = await legacyPhoto(job.jobId, job.steps[1].id, 'missing');
    const dry = await reconcileEvidence({ apply: false });
    assert.ok(dry.findings.some((f) => f.id === p.id && f.kind === 'MISSING'));
    const res = await reconcileEvidence({ apply: true, deep: true });
    assert.ok(res.results.some((r) => r.id === p.id && r.transitionedTo === 'FAILED'));
    const row = await db('job_photos').where({ id: p.id }).first();
    assert.equal(row.status, 'FAILED');
    assert.equal(row.failure_reason, 'LEGACY_MISSING');
    assert.notEqual(row.status, 'READY');
  });

  // ---- 3. Legacy same-size but modified bytes -> hash mismatch, never READY ----
  await test('legacy object with same size but altered bytes fails on sha256 and never becomes READY', async () => {
    const job = await mkJob('TRC003CC');
    const p = await legacyPhoto(job.jobId, job.steps[1].id, 'corrupt-samesize');
    const res = await reconcileEvidence({ apply: true, deep: true });
    const r = res.results.find((x) => x.id === p.id);
    assert.ok(r && r.kind === 'MISMATCH' && /sha256/.test(r.reason), `expected sha256 mismatch, got ${JSON.stringify(r)}`);
    const row = await db('job_photos').where({ id: p.id }).first();
    assert.equal(row.status, 'FAILED');
    assert.equal(row.failure_reason, 'LEGACY_HASH_MISMATCH');
  });

  // ---- 4. Dry-run changes nothing ----
  await test('dry-run detects but never mutates legacy rows', async () => {
    const job = await mkJob('TRC004DD');
    const ok = await legacyPhoto(job.jobId, job.steps[1].id, 'match');
    const gone = await legacyPhoto(job.jobId, job.steps[1].id, 'missing');
    const res = await reconcileEvidence({ apply: false, deep: true });
    assert.equal(res.dryRun, true);
    assert.equal(res.fixed, 0, 'dry-run performs no transitions');
    assert.equal((await db('job_photos').where({ id: ok.id }).first()).status, 'UNVERIFIED');
    assert.equal((await db('job_photos').where({ id: gone.id }).first()).status, 'UNVERIFIED');
  });

  // ---- 5. Apply mode performs audited transitions ----
  await test('apply audits EVIDENCE_VERIFIED for promotions and EVIDENCE_INTEGRITY_FAILURE for failures (no storage keys)', async () => {
    const job = await mkJob('TRC005EE');
    const ok = await legacyPhoto(job.jobId, job.steps[1].id, 'match');
    const gone = await legacyPhoto(job.jobId, job.steps[1].id, 'missing');
    await reconcileEvidence({ apply: true, deep: true });
    const verified = await db('audit_logs').where({ action: 'EVIDENCE_VERIFIED', entity_id: String(ok.id) }).first();
    const integrity = await db('audit_logs').where({ action: 'EVIDENCE_INTEGRITY_FAILURE', entity_id: String(gone.id) }).first();
    assert.ok(verified, 'promotion audited');
    assert.ok(integrity, 'failure audited');
    // Audit payloads must not carry the storage key/path.
    assert.ok(!JSON.stringify(verified).includes(ok.key), 'no storage key in the verified audit');
    assert.ok(!JSON.stringify(integrity).includes(gone.key), 'no storage key in the integrity audit');
  });

  // ---- 6. Interrupted run can resume safely ----
  await test('a transient storage error leaves the row UNVERIFIED; a re-run resolves it (resumable)', async () => {
    const job = await mkJob('TRC006FF');
    const p = await legacyPhoto(job.jobId, job.steps[1].id, 'match');
    storage.getStreamOverride.set(p.key, new StorageError('TIMEOUT', 'transient'));
    const first = await reconcileEvidence({ apply: true, deep: true });
    assert.ok(first.results.some((r) => r.id === p.id && r.kind === 'ERROR'), 'transient error recorded');
    assert.equal((await db('job_photos').where({ id: p.id }).first()).status, 'UNVERIFIED', 'left UNVERIFIED for retry');
    storage.getStreamOverride.delete(p.key);
    await reconcileEvidence({ apply: true, deep: true });
    assert.equal((await db('job_photos').where({ id: p.id }).first()).status, 'READY', 'resumed run promotes it');
  });

  // ---- 7. Re-running apply is idempotent ----
  await test('re-running apply is idempotent (no repeated transitions or audits)', async () => {
    const job = await mkJob('TRC007GG');
    const p = await legacyPhoto(job.jobId, job.steps[1].id, 'match');
    const first = await reconcileEvidence({ apply: true, deep: true });
    assert.equal(first.results.filter((r) => r.id === p.id && r.transitionedTo === 'READY').length, 1);
    const second = await reconcileEvidence({ apply: true, deep: true });
    assert.equal(second.results.some((r) => r.id === p.id && r.transitionedTo !== null), false, 'no second transition');
    const audits = await db('audit_logs').where({ action: 'EVIDENCE_VERIFIED', entity_id: String(p.id) });
    assert.equal(audits.length, 1, 'promotion audited exactly once');
  });

  // ---- 8. Newly uploaded READY evidence is not treated as legacy ----
  await test('a freshly uploaded READY photo is not touched by legacy verification', async () => {
    const job = await mkJob('TRC008HH');
    const up = await upload(`/api/v1/jobs/${job.jobId}/checklist/steps/${job.steps[1].id}/photos`, PNG, usta);
    assert.equal(up.status, 201);
    const before = await db('job_photos').where({ id: up.body.photo.id }).first();
    assert.equal(before.status, 'READY');
    const legacy = await legacyPhoto(job.jobId, job.steps[1].id, 'match');
    await reconcileEvidence({ apply: true, deep: true });
    const after = await db('job_photos').where({ id: up.body.photo.id }).first();
    assert.equal(after.status, 'READY');
    assert.equal(Number(after.ready_at), Number(before.ready_at), 'ready_at unchanged — not re-verified as legacy');
    // No EVIDENCE_VERIFIED (legacy-promotion) audit for the already-READY upload.
    const promoAudit = await db('audit_logs').where({ action: 'EVIDENCE_VERIFIED', entity_id: String(up.body.photo.id) }).first();
    assert.equal(promoAudit, undefined, 'upload is not audited as a legacy promotion');
    // The legacy sibling IS promoted.
    assert.equal((await db('job_photos').where({ id: legacy.id }).first()).status, 'READY');
  });

  await cleanup();
  server.close();
  await db.destroy();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

run().catch(async (err) => {
  console.error(err);
  try { await db.destroy(); } catch { /* ignore */ }
  process.exit(1);
});
