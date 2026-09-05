/**
 * EASY GAS — Phase 10D job assignment & responsibility.
 *
 *   npm run test:assignment   (after: npm run test:setup)
 *
 * Auto-assign at creation, the execution responsibility guard, reassignment
 * authorization + audit + immutable history, cross-branch / inactive / terminal
 * rejection, "my jobs", concurrency determinism, and preservation of actual
 * step performers across reassignment.
 *
 * Fixtures: users +99899000950x, "TEST ASG ..." names, TASG* plates.
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

const USERS = { admin: '+998990009501', ustaA: '+998990009502', ustaA2: '+998990009503', master: '+998990009504', ustaB: '+998990009505' };
const PASSWORD = 'Sinov-parol-123';

let baseUrl = '';
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
async function login(phone: string): Promise<string> {
  const res = await http('POST', '/api/v1/auth/login', { body: { phone, password: PASSWORD, rememberMe: false } });
  assert.equal(res.status, 200, `login ${phone}`);
  return res.setCookies.find((c) => c.startsWith('eg_session='))!.split(';')[0];
}
let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (err) { failed += 1; console.error(`  FAIL  ${name}`); console.error(`        ${err instanceof Error ? err.stack : String(err)}`); }
}

async function cleanup(): Promise<void> {
  const jobIds = (await db('jobs').join('vehicles', 'vehicles.id', 'jobs.vehicle_id').where('vehicles.plate_number', 'like', 'TASG%').select('jobs.id')).map((j: { id: number }) => j.id);
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
      if (stepIds.length > 0) { await db('step_measurements').whereIn('job_step_id', stepIds).del(); await db('audit_logs').where('entity_type', 'job_step').whereIn('entity_id', stepIds.map(String)).del(); await db('job_steps').whereIn('id', stepIds).del(); }
      await db('job_checklists').whereIn('id', clIds).del();
    }
    await db('audit_logs').whereIn('entity_type', ['job']).whereIn('entity_id', jobIds.map(String)).del();
    await db('jobs').whereIn('id', jobIds).del();
  }
  const tplIds = (await db('checklist_templates').where('name', 'like', 'TEST ASG%').select('id')).map((t: { id: number }) => t.id);
  if (tplIds.length > 0) {
    const vIds = (await db('checklist_template_versions').whereIn('template_id', tplIds).select('id')).map((v: { id: number }) => v.id);
    if (vIds.length > 0) { const sIds = (await db('checklist_steps').whereIn('version_id', vIds).select('id')).map((s: { id: number }) => s.id); if (sIds.length > 0) { await db('checklist_step_measurements').whereIn('step_id', sIds).del(); await db('checklist_steps').whereIn('id', sIds).del(); } await db('checklist_template_versions').whereIn('id', vIds).del(); }
    await db('checklist_templates').whereIn('id', tplIds).del();
  }
  const custIds = (await db('customers').where('name', 'like', 'TEST ASG%').select('id')).map((c: { id: number }) => c.id);
  await db('vehicles').where('plate_number', 'like', 'TASG%').del();
  if (custIds.length > 0) await db('customers').whereIn('id', custIds).del();
  const users = await db('users').whereIn('phone', Object.values(USERS)).select('id');
  const uids = users.map((u: { id: number }) => u.id);
  if (uids.length > 0) { await db('audit_logs').whereIn('user_id', uids).del(); await db('sessions').whereIn('user_id', uids).del(); }
  await db('users').whereIn('phone', Object.values(USERS)).del();
  await db('branches').where('name', 'like', 'TEST ASG%').del();
}

async function run(): Promise<void> {
  setSmsProviderForTesting({ name: 'test-capture', send: async () => ({ providerMessageId: null, outcome: 'ACCEPTED' as const }) });
  setStorageProviderForTesting(new MemoryStorageProvider());
  await assertTestDatabase(db);
  await cleanup();

  const roles = await db('roles').select('id', 'code');
  const roleId = (c: string) => roles.find((r: { code: string }) => r.code === c)?.id;
  const [branchA] = await db('branches').insert({ name: 'TEST ASG Branch A', region: 'Toshkent shahri', status: 'ACTIVE' });
  const [branchB] = await db('branches').insert({ name: 'TEST ASG Branch B', region: 'Samarqand', status: 'ACTIVE' });
  const pw = await bcrypt.hash(PASSWORD, 10);
  const b = { password_hash: pw, region: 'Toshkent shahri', status: 'ACTIVE' };
  const ins = async (r: Record<string, unknown>) => (await db('users').insert(r))[0] as number;
  const ids: Record<string, number> = {};
  ids.admin = await ins({ ...b, first_name: 'Asg', last_name: 'Admin', phone: USERS.admin, branch_id: null, role_id: roleId('ADMIN') });
  ids.ustaA = await ins({ ...b, first_name: 'Asg', last_name: 'UstaA', phone: USERS.ustaA, branch_id: branchA, role_id: roleId('USTA') });
  ids.ustaA2 = await ins({ ...b, first_name: 'Asg', last_name: 'UstaA2', phone: USERS.ustaA2, branch_id: branchA, role_id: roleId('USTA') });
  ids.master = await ins({ ...b, first_name: 'Asg', last_name: 'Master', phone: USERS.master, branch_id: branchA, role_id: roleId('MASTER') });
  ids.ustaB = await ins({ ...b, first_name: 'Asg', last_name: 'UstaB', phone: USERS.ustaB, branch_id: branchB, role_id: roleId('USTA') });

  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  console.log(`\nRunning assignment E2E against ${baseUrl}\n`);

  const usta = await login(USERS.ustaA);
  const usta2 = await login(USERS.ustaA2);
  const master = await login(USERS.master);
  const admin = await login(USERS.admin);

  const c = await http('POST', '/api/v1/customers', { cookie: usta, body: { name: 'TEST ASG Mijoz', phone: '99 000 95 11' } });
  const customerId = c.body.customer.id as number;
  const t = await http('POST', '/api/v1/checklist-templates', { cookie: admin, body: { name: 'TEST ASG Shablon' } });
  const templateId = t.body.template.id;
  const versionId = t.body.template.versions[0].id;
  for (const step of [{ name: 'Bosqich A' }, { name: 'Bosqich B' }]) {
    await http('POST', `/api/v1/checklist-templates/${templateId}/versions/${versionId}/steps`, { cookie: admin, body: step });
  }
  await http('POST', `/api/v1/checklist-templates/${templateId}/versions/${versionId}/publish`, { cookie: admin });

  let plate = 0;
  const mkJob = async (cookie = usta) => {
    const p = `TASG${String(++plate).padStart(3, '0')}`;
    const v = await http('POST', '/api/v1/vehicles', { cookie: usta, body: { customerId, plateNumber: p, make: 'Chevrolet', model: 'Spark' } });
    const j = await http('POST', '/api/v1/jobs', { cookie, body: { customerId, vehicleId: v.body.vehicle.id } });
    const jobId = j.body.job.id as number;
    await http('POST', `/api/v1/jobs/${jobId}/start`, { cookie });
    const a = await http('POST', `/api/v1/jobs/${jobId}/checklist`, { cookie, body: { templateId } });
    return { jobId, steps: a.body.checklist.steps as any[] };
  };
  const complete = (jobId: number, stepId: number, cookie: string) => http('POST', `/api/v1/jobs/${jobId}/checklist/steps/${stepId}/complete`, { cookie, body: {} });

  // ---- Auto-assign at creation ----
  await test('creation auto-assigns the creator (SELF_AT_CREATION) as responsible technician', async () => {
    const job = await mkJob(usta);
    const row = await db('jobs').where({ id: job.jobId }).first();
    assert.equal(row.assigned_technician_id, ids.ustaA);
    assert.equal(row.assignment_status, 'ASSIGNED');
    const hist = await db('job_assignments').where({ job_id: job.jobId });
    assert.equal(hist.length, 1);
    assert.equal(hist[0].provenance, 'SELF_AT_CREATION');
  });

  // ---- L13: a non-assigned same-branch technician cannot execute ----
  await test('L13: a same-branch but non-assigned USTA cannot perform checklist work (403)', async () => {
    const job = await mkJob(usta); // assigned to ustaA
    const res = await complete(job.jobId, job.steps[0].id, usta2);
    assert.equal(res.status, 403);
    assert.equal((await db('job_steps').where({ id: job.steps[0].id }).first()).status, 'PENDING');
  });

  // ---- L14 + audit: supervisor reassigns; new tech can work, old cannot ----
  await test('L14: a supervisor (MASTER) reassigns (audited); the new technician gains execution rights', async () => {
    const job = await mkJob(usta);
    const re = await http('POST', `/api/v1/jobs/${job.jobId}/assign`, { cookie: master, body: { technicianId: ids.ustaA2, reason: 'ish qayta taqsimlandi' } });
    assert.equal(re.status, 200, JSON.stringify(re.body));
    assert.equal((await db('jobs').where({ id: job.jobId }).first()).assigned_technician_id, ids.ustaA2);
    assert.ok(await db('audit_logs').where({ action: 'JOB_REASSIGNED', entity_id: String(job.jobId) }).first());
    // ustaA2 can now execute; ustaA (previous) cannot.
    assert.equal((await complete(job.jobId, job.steps[0].id, usta2)).status, 200);
    assert.equal((await complete(job.jobId, job.steps[1].id, usta)).status, 403);
  });

  // ---- unauthorized assign ----
  await test('a USTA (no jobs.assign) cannot reassign', async () => {
    const job = await mkJob(usta);
    assert.equal((await http('POST', `/api/v1/jobs/${job.jobId}/assign`, { cookie: usta, body: { technicianId: ids.ustaA2 } })).status, 403);
  });

  // ---- cross-branch assignment ----
  await test('cross-branch assignment is refused', async () => {
    const job = await mkJob(usta);
    const res = await http('POST', `/api/v1/jobs/${job.jobId}/assign`, { cookie: master, body: { technicianId: ids.ustaB } });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'CROSS_BRANCH_ASSIGNMENT');
  });

  // ---- inactive technician ----
  await test('assigning an inactive technician is refused', async () => {
    const job = await mkJob(usta);
    await db('users').where({ id: ids.ustaA2 }).update({ status: 'BLOCKED' });
    const res = await http('POST', `/api/v1/jobs/${job.jobId}/assign`, { cookie: master, body: { technicianId: ids.ustaA2 } });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'TECHNICIAN_INACTIVE');
    await db('users').where({ id: ids.ustaA2 }).update({ status: 'ACTIVE' });
  });

  // ---- L15: concurrent reassignment is deterministic ----
  await test('L15: two simultaneous reassignments are deterministic (one final state, both audited)', async () => {
    const job = await mkJob(usta);
    const before = (await db('job_assignments').where({ job_id: job.jobId })).length;
    const [a, b] = await Promise.all([
      http('POST', `/api/v1/jobs/${job.jobId}/assign`, { cookie: master, body: { technicianId: ids.ustaA2 } }),
      http('POST', `/api/v1/jobs/${job.jobId}/assign`, { cookie: admin, body: { technicianId: ids.master } }),
    ]);
    assert.ok(a.status === 200 && b.status === 200, `both serialize (got ${a.status},${b.status})`);
    const final = (await db('jobs').where({ id: job.jobId }).first()).assigned_technician_id;
    assert.ok([ids.ustaA2, ids.master].includes(final), 'final assignee is one of the two targets');
    assert.equal((await db('job_assignments').where({ job_id: job.jobId })).length, before + 2, 'both reassignments recorded in history');
  });

  // ---- L16: reassignment preserves the actual step performer ----
  await test('L16: reassignment does not rewrite who actually performed completed steps', async () => {
    const job = await mkJob(usta);
    assert.equal((await complete(job.jobId, job.steps[0].id, usta)).status, 200); // performed by ustaA
    const performedBy = (await db('job_steps').where({ id: job.steps[0].id }).first()).completed_by;
    assert.equal(performedBy, ids.ustaA);
    await http('POST', `/api/v1/jobs/${job.jobId}/assign`, { cookie: master, body: { technicianId: ids.ustaA2 } });
    // The historical performer is unchanged despite the new responsible tech.
    assert.equal((await db('job_steps').where({ id: job.steps[0].id }).first()).completed_by, ids.ustaA);
  });

  // ---- "my jobs" filter ----
  await test('"my assigned jobs" returns only the caller\'s assigned jobs and reflects reassignment', async () => {
    const job = await mkJob(usta); // assigned ustaA
    const mineA = await http('GET', '/api/v1/jobs/mine', { cookie: usta });
    assert.ok(mineA.body.items.some((j: any) => j.id === job.jobId), 'ustaA sees the job');
    await http('POST', `/api/v1/jobs/${job.jobId}/assign`, { cookie: master, body: { technicianId: ids.ustaA2 } });
    const mineA2 = await http('GET', '/api/v1/jobs/mine', { cookie: usta });
    assert.ok(!mineA2.body.items.some((j: any) => j.id === job.jobId), 'after reassign ustaA no longer sees it');
    const mineUsta2 = await http('GET', '/api/v1/jobs/mine', { cookie: usta2 });
    assert.ok(mineUsta2.body.items.some((j: any) => j.id === job.jobId), 'ustaA2 now sees it');
  });

  // ---- assignment after terminal state ----
  await test('reassignment is refused after the job is cancelled (terminal)', async () => {
    const job = await mkJob(usta);
    await http('POST', `/api/v1/jobs/${job.jobId}/cancel`, { cookie: usta, body: { reason: 'bekor qilindi' } });
    const res = await http('POST', `/api/v1/jobs/${job.jobId}/assign`, { cookie: master, body: { technicianId: ids.ustaA2 } });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'JOB_TERMINAL');
  });

  await cleanup();
  server.close();
  await db.destroy();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

run().catch(async (err) => { console.error(err); try { await db.destroy(); } catch { /* ignore */ } process.exit(1); });
