/**
 * EASY GAS — Phase 10D risk engine + critical-completion-gate + STOP/risk link.
 *
 *   npm run test:risk   (after: npm run test:setup)
 *
 * Server-authoritative scoring, the §22 "no unresolved critical issue" gate,
 * RBAC/branch scoping, the STOP↔risk link, and job-lock concurrency
 * (create/resolve/revise racing close). No sleeps — races assert the invariant
 * regardless of winner.
 *
 * Fixtures: users +99899000940x, "TEST RSK ..." names, TRSK* plates.
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

const USERS = { admin: '+998990009401', ustaA: '+998990009402', masterA: '+998990009403', sifat: '+998990009404', ustaB: '+998990009405' };
const PASSWORD = 'Sinov-parol-123';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let baseUrl = '';
let storage: MemoryStorageProvider;

interface HttpResult { status: number; body: any; setCookies: string[] }
async function http(method: string, p: string, opts: { body?: unknown; cookie?: string } = {}): Promise<HttpResult> {
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(opts.cookie ? { cookie: opts.cookie, 'x-csrf-token': csrfTokenFor(opts.cookie.split('=')[1] ?? '') } : {}) },
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
  const res = await fetch(`${baseUrl}${p}`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrfTokenFor(cookie.split('=')[1] ?? '') }, body: form });
  return { status: res.status, body: JSON.parse((await res.text()) || 'null'), setCookies: [] };
}
async function uploadSig(jobId: number, cookie: string): Promise<HttpResult> {
  const form = new FormData();
  form.append('signature', new Blob([new Uint8Array(PNG)], { type: 'image/png' }), 'sig.png');
  const res = await fetch(`${baseUrl}/api/v1/jobs/${jobId}/signature`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrfTokenFor(cookie.split('=')[1] ?? '') }, body: form });
  return { status: res.status, body: JSON.parse((await res.text()) || 'null'), setCookies: [] };
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

async function cleanup(): Promise<void> {
  const jobIds = (await db('jobs').join('vehicles', 'vehicles.id', 'jobs.vehicle_id').where('vehicles.plate_number', 'like', 'TRSK%').select('jobs.id')).map((j: { id: number }) => j.id);
  if (jobIds.length > 0) {
    await db('risk_events').whereIn('job_id', jobIds).del();
    await db('completion_snapshots').whereIn('job_id', jobIds).del();
    await db('job_assignments').whereIn('job_id', jobIds).del();
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
    await db('audit_logs').whereIn('entity_type', ['job', 'job_photo', 'risk_event', 'stop_approval']).whereIn('entity_id', jobIds.map(String)).del();
    await db('jobs').whereIn('id', jobIds).del();
  }
  const tplIds = (await db('checklist_templates').where('name', 'like', 'TEST RSK%').select('id')).map((t: { id: number }) => t.id);
  if (tplIds.length > 0) {
    const vIds = (await db('checklist_template_versions').whereIn('template_id', tplIds).select('id')).map((v: { id: number }) => v.id);
    if (vIds.length > 0) {
      const sIds = (await db('checklist_steps').whereIn('version_id', vIds).select('id')).map((s: { id: number }) => s.id);
      if (sIds.length > 0) { await db('checklist_step_measurements').whereIn('step_id', sIds).del(); await db('checklist_steps').whereIn('id', sIds).del(); }
      await db('checklist_template_versions').whereIn('id', vIds).del();
    }
    await db('checklist_templates').whereIn('id', tplIds).del();
  }
  const custIds = (await db('customers').where('name', 'like', 'TEST RSK%').select('id')).map((c: { id: number }) => c.id);
  await db('vehicles').where('plate_number', 'like', 'TRSK%').del();
  if (custIds.length > 0) await db('customers').whereIn('id', custIds).del();
  const users = await db('users').whereIn('phone', Object.values(USERS)).select('id');
  const uids = users.map((u: { id: number }) => u.id);
  if (uids.length > 0) { await db('audit_logs').whereIn('user_id', uids).del(); await db('sessions').whereIn('user_id', uids).del(); }
  await db('users').whereIn('phone', Object.values(USERS)).del();
  await db('branches').where('name', 'like', 'TEST RSK%').del();
}

async function run(): Promise<void> {
  setSmsProviderForTesting({ name: 'test-capture', send: async () => ({ providerMessageId: null, outcome: 'ACCEPTED' as const }) });
  storage = new MemoryStorageProvider();
  setStorageProviderForTesting(storage);
  await assertTestDatabase(db);
  await cleanup();

  const roles = await db('roles').select('id', 'code');
  const roleId = (c: string) => roles.find((r: { code: string }) => r.code === c)?.id;
  const [branchA] = await db('branches').insert({ name: 'TEST RSK Branch A', region: 'Toshkent shahri', status: 'ACTIVE' });
  const [branchB] = await db('branches').insert({ name: 'TEST RSK Branch B', region: 'Samarqand', status: 'ACTIVE' });
  const pw = await bcrypt.hash(PASSWORD, 10);
  const base = { password_hash: pw, region: 'Toshkent shahri', status: 'ACTIVE' };
  const ins = async (r: Record<string, unknown>) => (await db('users').insert(r))[0] as number;
  await ins({ ...base, first_name: 'Rsk', last_name: 'Admin', phone: USERS.admin, branch_id: null, role_id: roleId('ADMIN') });
  await ins({ ...base, first_name: 'Rsk', last_name: 'UstaA', phone: USERS.ustaA, branch_id: branchA, role_id: roleId('USTA') });
  await ins({ ...base, first_name: 'Rsk', last_name: 'MasterA', phone: USERS.masterA, branch_id: branchA, role_id: roleId('MASTER') });
  await ins({ ...base, first_name: 'Rsk', last_name: 'Sifat', phone: USERS.sifat, branch_id: null, role_id: roleId('SIFAT') });
  await ins({ ...base, first_name: 'Rsk', last_name: 'UstaB', phone: USERS.ustaB, branch_id: branchB, role_id: roleId('USTA') });

  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  console.log(`\nRunning risk E2E against ${baseUrl}\n`);

  const usta = await login(USERS.ustaA);
  const master = await login(USERS.masterA);
  const sifat = await login(USERS.sifat);
  const admin = await login(USERS.admin);
  const ustaB = await login(USERS.ustaB);

  const c = await http('POST', '/api/v1/customers', { cookie: usta, body: { name: 'TEST RSK Mijoz', phone: '99 000 94 11' } });
  const customerId = c.body.customer.id as number;
  const t = await http('POST', '/api/v1/checklist-templates', { cookie: admin, body: { name: 'TEST RSK Shablon' } });
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

  let plate = 0;
  const mkJob = async () => {
    const p = `TRSK${String(++plate).padStart(3, '0')}`;
    const v = await http('POST', '/api/v1/vehicles', { cookie: usta, body: { customerId, plateNumber: p, make: 'Chevrolet', model: 'Spark' } });
    const j = await http('POST', '/api/v1/jobs', { cookie: usta, body: { customerId, vehicleId: v.body.vehicle.id } });
    const jobId = j.body.job.id as number;
    await http('POST', `/api/v1/jobs/${jobId}/start`, { cookie: usta });
    const a = await http('POST', `/api/v1/jobs/${jobId}/checklist`, { cookie: usta, body: { templateId } });
    return { jobId, steps: a.body.checklist.steps as any[] };
  };
  const stepPath = (jobId: number, stepId: number) => `/api/v1/jobs/${jobId}/checklist/steps/${stepId}/photos`;
  const complete = (jobId: number, stepId: number, body: any = {}) => http('POST', `/api/v1/jobs/${jobId}/checklist/steps/${stepId}/complete`, { cookie: usta, body });
  const close = (jobId: number, cookie = master) => http('POST', `/api/v1/jobs/${jobId}/complete`, { cookie });

  /** Drive to closeable (all §22 gates pass, STOP approved, signed) — no risks. */
  const driveToCloseable = async (job: { jobId: number; steps: any[] }) => {
    await complete(job.jobId, job.steps[0].id);
    await upload(stepPath(job.jobId, job.steps[1].id), PNG, usta);
    await complete(job.jobId, job.steps[1].id, { measurements: [{ measurementId: job.steps[1].measurements[0].id, value: 15 }] });
    await upload(stepPath(job.jobId, job.steps[2].id), PNG, usta);
    await complete(job.jobId, job.steps[2].id); // STOP → WAITING_STOP_APPROVAL
    await http('POST', `/api/v1/jobs/${job.jobId}/stop/approve`, { cookie: master });
    assert.equal((await uploadSig(job.jobId, usta)).status, 201);
  };
  const openBlocking = (jobId: number, cycle = 1) =>
    db('risk_events').where({ job_id: jobId, cycle, blocking: true }).whereIn('status', ['OPEN', 'MITIGATION_IN_PROGRESS']);
  const mkRisk = (jobId: number, cookie: string, sev = 4, lik = 4) =>
    http('POST', `/api/v1/jobs/${jobId}/risks`, { cookie, body: { hazard: 'Gaz sizishi', description: 'Xavfli holat', severity: sev, likelihood: lik } });

  // ---- L1: open blocking risk prevents close ----
  await test('L1: an open CRITICAL (blocking) risk prevents close', async () => {
    const job = await mkJob(); await driveToCloseable(job);
    const r = await mkRisk(job.jobId, usta, 4, 4);
    assert.equal(r.status, 201);
    const cl = await close(job.jobId);
    assert.equal(cl.status, 422);
    assert.ok(cl.body.error.details.some((d: any) => d.code === 'CRITICAL_RISK_UNRESOLVED'), JSON.stringify(cl.body));
  });

  // ---- L2: resolved risk permits close ----
  await test('L2: resolving the blocking risk permits close', async () => {
    const job = await mkJob(); await driveToCloseable(job);
    const r = await mkRisk(job.jobId, usta, 4, 4);
    assert.equal((await close(job.jobId)).status, 422);
    const res = await http('POST', `/api/v1/jobs/${job.jobId}/risks/${r.body.risk.id}/resolve`, { cookie: master, body: { note: 'Mitigatsiya bajarildi' } });
    assert.equal(res.status, 200);
    assert.equal((await close(job.jobId)).status, 200);
  });

  // ---- L3: non-blocking risk does not block ----
  await test('L3: a non-blocking (LOW/MEDIUM) risk does not prevent close', async () => {
    const job = await mkJob(); await driveToCloseable(job);
    const r = await mkRisk(job.jobId, usta, 1, 1); // score 1 → LOW, non-blocking
    const row = await db('risk_events').where({ id: r.body.risk.id }).first();
    assert.equal(row.level, 'LOW');
    assert.equal(!!row.blocking, false);
    assert.equal((await close(job.jobId)).status, 200);
  });

  // ---- L4: client cannot forge a lower score/blocking ----
  await test('L4: score/level/blocking are server-computed — client cannot forge them', async () => {
    const job = await mkJob();
    // Client sends a bogus level/blocking + high severity — backend ignores the
    // level, computes CRITICAL+blocking from severity×likelihood.
    const r = await http('POST', `/api/v1/jobs/${job.jobId}/risks`, { cookie: usta, body: { hazard: 'Gaz', description: 'forge attempt', severity: 4, likelihood: 4, level: 'LOW', blocking: false, score: 1 } });
    assert.equal(r.status, 201);
    const row = await db('risk_events').where({ id: r.body.risk.id }).first();
    assert.equal(row.level, 'CRITICAL');
    assert.equal(!!row.blocking, true);
    assert.equal(row.score, 16);
    assert.equal(row.matrix_version, 'v1');
  });

  // ---- L5: unauthorized actor cannot resolve ----
  await test('L5: a USTA (no risks.resolve) cannot resolve a risk', async () => {
    const job = await mkJob();
    const r = await mkRisk(job.jobId, usta, 4, 4);
    const res = await http('POST', `/api/v1/jobs/${job.jobId}/risks/${r.body.risk.id}/resolve`, { cookie: usta, body: { note: 'x' } });
    assert.equal(res.status, 403);
    assert.equal((await db('risk_events').where({ id: r.body.risk.id }).first()).status, 'OPEN');
  });

  // ---- L6: cross-branch risk access refused ----
  await test('L6: a cross-branch actor cannot create or list risks (404)', async () => {
    const job = await mkJob();
    assert.equal((await mkRisk(job.jobId, ustaB, 4, 4)).status, 404);
    assert.equal((await http('GET', `/api/v1/jobs/${job.jobId}/risks`, { cookie: ustaB })).status, 404);
  });

  // ---- L7: blocking-risk creation racing close is safe ----
  await test('L7: creating a blocking risk while closing → exactly one safe outcome', async () => {
    const job = await mkJob(); await driveToCloseable(job);
    const [cl, rk] = await Promise.all([close(job.jobId), mkRisk(job.jobId, usta, 4, 4)]);
    const blockers = await openBlocking(job.jobId);
    if (cl.status === 200) assert.equal(blockers.length, 0, 'a closed job has no open blocking risk');
    else { assert.equal(cl.status, 422); assert.ok(blockers.length >= 1 || rk.status !== 201); }
  });

  // ---- L8: risk resolution racing close is safe ----
  await test('L8: resolving a risk while closing → never close-with-open-blocker', async () => {
    const job = await mkJob(); await driveToCloseable(job);
    const r = await mkRisk(job.jobId, usta, 4, 4);
    const [cl] = await Promise.all([
      close(job.jobId),
      http('POST', `/api/v1/jobs/${job.jobId}/risks/${r.body.risk.id}/resolve`, { cookie: master, body: { note: 'resolve race' } }),
    ]);
    const blockers = await openBlocking(job.jobId);
    if (cl.status === 200) assert.equal(blockers.length, 0);
    else assert.equal(cl.status, 422);
  });

  // ---- downgrade (revise) racing close is safe ----
  await test('L8b: revising a blocking risk to non-blocking while closing is safe', async () => {
    const job = await mkJob(); await driveToCloseable(job);
    const r = await mkRisk(job.jobId, usta, 4, 4);
    const [cl] = await Promise.all([
      close(job.jobId),
      http('POST', `/api/v1/jobs/${job.jobId}/risks/${r.body.risk.id}/revise`, { cookie: master, body: { severity: 1, likelihood: 1, reason: 'reassessed' } }),
    ]);
    const blockers = await openBlocking(job.jobId);
    if (cl.status === 200) assert.equal(blockers.length, 0);
    else assert.equal(cl.status, 422);
    // The original blocking record is preserved (superseded), never deleted.
    assert.ok(await db('risk_events').where({ id: r.body.risk.id }).first());
  });

  // ---- two simultaneous resolutions ----
  await test('L8c: two simultaneous resolutions → exactly one succeeds', async () => {
    const job = await mkJob();
    const r = await mkRisk(job.jobId, usta, 4, 4);
    const [a, b] = await Promise.all([
      http('POST', `/api/v1/jobs/${job.jobId}/risks/${r.body.risk.id}/resolve`, { cookie: master, body: { note: 'resolve one' } }),
      http('POST', `/api/v1/jobs/${job.jobId}/risks/${r.body.risk.id}/resolve`, { cookie: sifat, body: { note: 'resolve two' } }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409], `one resolves, one conflicts (got ${statuses})`);
  });

  // ---- L9: quality confirmation re-checks risk ----
  await test('L9: quality confirmation re-checks the risk gate (blocked by a new cycle-2 risk)', async () => {
    const job = await mkJob(); await driveToCloseable(job);
    assert.equal((await close(job.jobId)).status, 200); // COMPLETED cycle 1
    assert.equal((await http('POST', `/api/v1/jobs/${job.jobId}/reopen`, { cookie: sifat, body: { reason: 'qayta korish' } })).status, 200);
    // cycle 2: re-sign, then raise a blocking risk → confirmQuality (close) blocked.
    assert.equal((await uploadSig(job.jobId, usta)).status, 201);
    const reClose = await close(job.jobId); // REOPENED → QUALITY_REVIEW
    assert.equal(reClose.status, 200);
    assert.equal((await db('jobs').where({ id: job.jobId }).first()).status, 'QUALITY_REVIEW');
    const r = await mkRisk(job.jobId, usta, 4, 4); // cycle-2 blocking risk
    assert.equal(r.status, 201);
    const conf = await http('POST', `/api/v1/jobs/${job.jobId}/quality/confirm`, { cookie: sifat });
    assert.equal(conf.status, 422, JSON.stringify(conf.body));
    assert.ok(conf.body.error.details.some((d: any) => d.code === 'CRITICAL_RISK_UNRESOLVED'));
  });

  // ---- L10 + L11: reopen preserves old risks; prior-cycle resolution ≠ current ----
  await test('L10/L11: reopen preserves cycle-1 risks; a cycle-1 resolution does not clear a cycle-2 blocker', async () => {
    const job = await mkJob(); await driveToCloseable(job);
    const r1 = await mkRisk(job.jobId, usta, 4, 4); // cycle 1 blocking
    await http('POST', `/api/v1/jobs/${job.jobId}/risks/${r1.body.risk.id}/resolve`, { cookie: master, body: { note: 'cycle-1 resolved' } });
    assert.equal((await close(job.jobId)).status, 200); // cycle 1 closes
    assert.equal((await http('POST', `/api/v1/jobs/${job.jobId}/reopen`, { cookie: sifat, body: { reason: 'reopen' } })).status, 200);
    // cycle-1 risk still present (history preserved).
    assert.ok(await db('risk_events').where({ id: r1.body.risk.id, cycle: 1 }).first());
    // cycle-2 blocking risk; resolving the (already-resolved) cycle-1 risk must not help.
    const r2 = await mkRisk(job.jobId, usta, 4, 4);
    assert.equal((await db('risk_events').where({ id: r2.body.risk.id }).first()).cycle, 2);
    assert.equal((await uploadSig(job.jobId, usta)).status, 201);
    const cl = await close(job.jobId);
    assert.equal(cl.status, 422, 'cycle-2 blocker still blocks despite cycle-1 being resolved');
  });

  // ---- L12: STOP/risk link ----
  await test('L12: a rejected STOP auto-creates a blocking risk; approval resolves it', async () => {
    const job = await mkJob();
    await complete(job.jobId, job.steps[0].id);
    await upload(stepPath(job.jobId, job.steps[1].id), PNG, usta);
    await complete(job.jobId, job.steps[1].id, { measurements: [{ measurementId: job.steps[1].measurements[0].id, value: 15 }] });
    await upload(stepPath(job.jobId, job.steps[2].id), PNG, usta);
    await complete(job.jobId, job.steps[2].id); // STOP submitted
    assert.equal((await http('POST', `/api/v1/jobs/${job.jobId}/stop/reject`, { cookie: master, body: { reason: 'notogri montaj' } })).status, 200);
    // A blocking STOP-linked risk exists (deduplicated).
    const linked = await db('risk_events').where({ job_id: job.jobId, cycle: 1, source: 'STOP_REJECTED' });
    assert.equal(linked.length, 1);
    assert.equal(linked[0].blocking, 1);
    assert.equal(linked[0].status, 'OPEN');
    // Rework + fresh evidence (Phase 10B: new attempt needs a new photo) +
    // resubmit + approve → the linked risk is resolved (approval = mitigation).
    assert.equal((await http('POST', `/api/v1/jobs/${job.jobId}/stop/rework`, { cookie: usta })).status, 200);
    await upload(stepPath(job.jobId, job.steps[2].id), PNG, usta);
    await complete(job.jobId, job.steps[2].id);
    assert.equal((await http('POST', `/api/v1/jobs/${job.jobId}/stop/approve`, { cookie: master })).status, 200);
    assert.equal((await db('risk_events').where({ id: linked[0].id }).first()).status, 'RESOLVED');
  });

  await cleanup();
  server.close();
  await db.destroy();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

run().catch(async (err) => { console.error(err); try { await db.destroy(); } catch { /* ignore */ } process.exit(1); });
