/**
 * EASY GAS — Phase 10D GPS evidence (loyiha.md §20).
 *
 *   npm run test:gps   (after: npm run test:setup)
 *
 * Client-reported location validation (ranges / NaN / null-island / accuracy /
 * stale / future), server + client timestamps, RBAC/branch scope, audited
 * capture + rejection (no coordinates in audit payload), and authorized override.
 *
 * Fixtures: users +99899000970x, "TEST GPS ..." names, TGPS* plates.
 */
import { assertTestDatabase } from './helpers/test-env';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import { db } from '../src/config/database';
import { createApp } from '../src/app';
import { csrfTokenFor } from '../src/middleware/csrf.middleware';
import { setSmsProviderForTesting } from '../src/sms';
import { setStorageProviderForTesting } from '../src/storage';
import { MemoryStorageProvider } from './helpers/memory-storage';
import { validateGps } from '../src/modules/gps/gps.service';

const USERS = { admin: '+998990009701', usta: '+998990009702', master: '+998990009703', ustaB: '+998990009704' };
const PASSWORD = 'Sinov-parol-123';
// Tashkent-ish coordinate.
const OK = () => ({ latitude: 41.311081, longitude: 69.240562, accuracy: 12, clientTimestamp: new Date().toISOString() });

let baseUrl = '';
interface HttpResult { status: number; body: any; setCookies: string[] }
async function http(method: string, p: string, opts: { body?: unknown; cookie?: string } = {}): Promise<HttpResult> {
  const res = await fetch(`${baseUrl}${p}`, { method, headers: { 'content-type': 'application/json', ...(opts.cookie ? { cookie: opts.cookie, 'x-csrf-token': csrfTokenFor(opts.cookie.split('=')[1] ?? '') } : {}) }, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
  const text = await res.text(); let body: any = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, setCookies: res.headers.getSetCookie() };
}
async function login(phone: string): Promise<string> { const r = await http('POST', '/api/v1/auth/login', { body: { phone, password: PASSWORD, rememberMe: false } }); assert.equal(r.status, 200, `login ${phone}`); return r.setCookies.find((c) => c.startsWith('eg_session='))!.split(';')[0]; }
let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> { try { await fn(); passed += 1; console.log(`  PASS  ${name}`); } catch (err) { failed += 1; console.error(`  FAIL  ${name}`); console.error(`        ${err instanceof Error ? err.stack : String(err)}`); } }

async function cleanup(): Promise<void> {
  const jobIds = (await db('jobs').join('vehicles', 'vehicles.id', 'jobs.vehicle_id').where('vehicles.plate_number', 'like', 'TGPS%').select('jobs.id')).map((j: { id: number }) => j.id);
  if (jobIds.length > 0) {
    await db('job_gps_events').whereIn('job_id', jobIds).del();
    await db('risk_events').whereIn('job_id', jobIds).del();
    await db('completion_snapshots').whereIn('job_id', jobIds).del();
    await db('job_assignments').whereIn('job_id', jobIds).del();
    await db('customer_signatures').whereIn('job_id', jobIds).del();
    await db('job_photos').whereIn('job_id', jobIds).del();
    await db('stop_approvals').whereIn('job_id', jobIds).del();
    const clIds = (await db('job_checklists').whereIn('job_id', jobIds).select('id')).map((c: { id: number }) => c.id);
    if (clIds.length > 0) { const stepIds = (await db('job_steps').whereIn('job_checklist_id', clIds).select('id')).map((s: { id: number }) => s.id); if (stepIds.length > 0) { await db('step_measurements').whereIn('job_step_id', stepIds).del(); await db('job_steps').whereIn('id', stepIds).del(); } await db('job_checklists').whereIn('id', clIds).del(); }
    await db('audit_logs').whereIn('entity_type', ['job']).whereIn('entity_id', jobIds.map(String)).del();
    await db('jobs').whereIn('id', jobIds).del();
  }
  const custIds = (await db('customers').where('name', 'like', 'TEST GPS%').select('id')).map((c: { id: number }) => c.id);
  await db('vehicles').where('plate_number', 'like', 'TGPS%').del();
  if (custIds.length > 0) await db('customers').whereIn('id', custIds).del();
  const users = await db('users').whereIn('phone', Object.values(USERS)).select('id');
  const uids = users.map((u: { id: number }) => u.id);
  if (uids.length > 0) { await db('audit_logs').whereIn('user_id', uids).del(); await db('sessions').whereIn('user_id', uids).del(); }
  await db('users').whereIn('phone', Object.values(USERS)).del();
  await db('branches').where('name', 'like', 'TEST GPS%').del();
}

async function run(): Promise<void> {
  setSmsProviderForTesting({ name: 'test-capture', send: async () => ({ providerMessageId: null, outcome: 'ACCEPTED' as const }) });
  setStorageProviderForTesting(new MemoryStorageProvider());
  await assertTestDatabase(db);
  await cleanup();

  const roles = await db('roles').select('id', 'code');
  const roleId = (c: string) => roles.find((r: { code: string }) => r.code === c)?.id;
  const [branchA] = await db('branches').insert({ name: 'TEST GPS Branch A', region: 'Toshkent shahri', status: 'ACTIVE' });
  const [branchB] = await db('branches').insert({ name: 'TEST GPS Branch B', region: 'Samarqand', status: 'ACTIVE' });
  const pw = await bcrypt.hash(PASSWORD, 10);
  const b = { password_hash: pw, region: 'Toshkent shahri', status: 'ACTIVE' };
  const ins = async (r: Record<string, unknown>) => (await db('users').insert(r))[0] as number;
  await ins({ ...b, first_name: 'Gps', last_name: 'Admin', phone: USERS.admin, branch_id: null, role_id: roleId('ADMIN') });
  await ins({ ...b, first_name: 'Gps', last_name: 'Usta', phone: USERS.usta, branch_id: branchA, role_id: roleId('USTA') });
  await ins({ ...b, first_name: 'Gps', last_name: 'Master', phone: USERS.master, branch_id: branchA, role_id: roleId('MASTER') });
  await ins({ ...b, first_name: 'Gps', last_name: 'UstaB', phone: USERS.ustaB, branch_id: branchB, role_id: roleId('USTA') });

  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  console.log(`\nRunning GPS E2E against ${baseUrl}\n`);

  const usta = await login(USERS.usta);
  const master = await login(USERS.master);
  const ustaB = await login(USERS.ustaB);

  const c = await http('POST', '/api/v1/customers', { cookie: usta, body: { name: 'TEST GPS Mijoz', phone: '99 000 97 11' } });
  const customerId = c.body.customer.id as number;
  let plate = 0;
  const mkJob = async () => {
    const p = `TGPS${String(++plate).padStart(3, '0')}`;
    const v = await http('POST', '/api/v1/vehicles', { cookie: usta, body: { customerId, plateNumber: p, make: 'Chevrolet', model: 'Spark' } });
    const j = await http('POST', '/api/v1/jobs', { cookie: usta, body: { customerId, vehicleId: v.body.vehicle.id } });
    await http('POST', `/api/v1/jobs/${j.body.job.id}/start`, { cookie: usta });
    return j.body.job.id as number;
  };
  const capture = (jobId: number, body: any, cookie = usta) => http('POST', `/api/v1/jobs/${jobId}/gps`, { cookie, body });

  // ---- valid capture ----
  await test('valid GPS is stored with client + server timestamps and VALIDATED provenance', async () => {
    const jobId = await mkJob();
    const res = await capture(jobId, { ...OK(), purpose: 'JOB_START' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const row = await db('job_gps_events').where({ id: res.body.gps.id }).first();
    assert.equal(row.provenance, 'VALIDATED');
    assert.ok(row.client_timestamp && row.server_received_at, 'both timestamps stored');
    assert.equal(Number(row.latitude).toFixed(4), '41.3111');
    // Capture audited, with NO coordinates in the audit payload.
    const audit = await db('audit_logs').where({ action: 'GPS_CAPTURED', entity_id: String(jobId) }).first();
    assert.ok(audit);
    assert.ok(!/41\.311|69\.240/.test(audit.new_value ?? ''), 'coordinates are not in the audit payload');
  });

  // ---- L26: invalid ranges + NaN + null-island ----
  await test('L26: out-of-range / NaN / null-island coordinates are rejected (422) and audited', async () => {
    const jobId = await mkJob();
    assert.equal((await capture(jobId, { ...OK(), latitude: 200 })).body.error.details[0].code, 'OUT_OF_RANGE');
    assert.equal((await capture(jobId, { ...OK(), longitude: 999 })).body.error.details[0].code, 'OUT_OF_RANGE');
    assert.equal((await capture(jobId, { ...OK(), latitude: 'nan-not-a-number' })).status, 422); // schema/coerce → NaN
    assert.equal((await capture(jobId, { ...OK(), latitude: 0, longitude: 0 })).body.error.details[0].code, 'NULL_ISLAND');
    assert.ok(await db('audit_logs').where({ action: 'GPS_REJECTED', entity_id: String(jobId) }).first());
    assert.equal((await db('job_gps_events').where({ job_id: jobId, provenance: 'VALIDATED' })).length, 0, 'no invalid coordinate stored');
  });

  // ---- L27: stale / future timestamps ----
  await test('L27: stale and future client timestamps are rejected', async () => {
    const jobId = await mkJob();
    const stale = await capture(jobId, { ...OK(), clientTimestamp: new Date(Date.now() - 3600_000).toISOString() });
    assert.equal(stale.body.error.details[0].code, 'STALE');
    const future = await capture(jobId, { ...OK(), clientTimestamp: new Date(Date.now() + 3600_000).toISOString() });
    assert.equal(future.body.error.details[0].code, 'FUTURE_TIMESTAMP');
  });

  // ---- L28: low accuracy ----
  await test('L28: a coordinate worse than the accuracy policy is rejected', async () => {
    const jobId = await mkJob();
    const res = await capture(jobId, { ...OK(), accuracy: 5000 });
    assert.equal(res.body.error.details[0].code, 'LOW_ACCURACY');
  });

  // ---- validateGps pure-function determinism ----
  await test('validateGps is a deterministic pure policy function', async () => {
    const now = 1_000_000_000_000;
    assert.equal(validateGps({ latitude: 41, longitude: 69, accuracy: 10, clientTimestamp: now }, now), null);
    assert.equal(validateGps({ latitude: 91, longitude: 69, accuracy: 10, clientTimestamp: now }, now), 'OUT_OF_RANGE');
    assert.equal(validateGps({ latitude: Infinity, longitude: 69, accuracy: 10, clientTimestamp: now }, now), 'NAN_OR_INFINITE');
    assert.equal(validateGps({ latitude: 0, longitude: 0, accuracy: 10, clientTimestamp: now }, now), 'NULL_ISLAND');
  });

  // ---- cross-branch ----
  await test('cross-branch GPS capture is refused (404)', async () => {
    const jobId = await mkJob();
    assert.equal((await capture(jobId, OK(), ustaB)).status, 404);
  });

  // ---- L30: override requires permission + reason ----
  await test('L30: GPS override requires an authorized role AND a reason', async () => {
    const jobId = await mkJob();
    // USTA lacks gps.override.
    assert.equal((await http('POST', `/api/v1/jobs/${jobId}/gps/override`, { cookie: usta, body: { reason: 'no signal' } })).status, 403);
    // MASTER without reason → 422.
    assert.equal((await http('POST', `/api/v1/jobs/${jobId}/gps/override`, { cookie: master, body: {} })).status, 422);
    // MASTER with reason → 201, recorded as OVERRIDE + audited.
    const ok = await http('POST', `/api/v1/jobs/${jobId}/gps/override`, { cookie: master, body: { reason: 'GPS signali yoq — bino ichida' } });
    assert.equal(ok.status, 201);
    assert.equal((await db('job_gps_events').where({ id: ok.body.gps.id }).first()).provenance, 'OVERRIDE');
    assert.ok(await db('audit_logs').where({ action: 'GPS_OVERRIDE', entity_id: String(jobId) }).first());
  });

  await cleanup();
  server.close();
  await db.destroy();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

run().catch(async (err) => { console.error(err); try { await db.destroy(); } catch { /* ignore */ } process.exit(1); });
