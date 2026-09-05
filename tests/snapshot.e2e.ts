/**
 * EASY GAS — Phase 10D completion snapshot + signable summary + digest binding.
 *
 *   npm run test:snapshot   (after: npm run test:setup)
 *
 * Canonical-serialization determinism, signable-summary digest sensitivity to
 * material changes, immutable completion snapshots (frozen against later
 * customer/vehicle edits), retry/uniqueness idempotency, and stale-signature /
 * re-sign behavior.
 *
 * Fixtures: users +99899000960x, "TEST SNP ..." names, TSNP* plates.
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
import { canonicalStringify, digestOf } from '../src/modules/completion/canonical';

const USERS = { admin: '+998990009601', ustaA: '+998990009602', master: '+998990009603', ustaA2: '+998990009604', sifat: '+998990009605' };
const PASSWORD = 'Sinov-parol-123';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let baseUrl = '';
let storage: MemoryStorageProvider;
interface HttpResult { status: number; body: any; setCookies: string[] }
async function http(method: string, p: string, opts: { body?: unknown; cookie?: string } = {}): Promise<HttpResult> {
  const res = await fetch(`${baseUrl}${p}`, { method, headers: { 'content-type': 'application/json', ...(opts.cookie ? { cookie: opts.cookie, 'x-csrf-token': csrfTokenFor(opts.cookie.split('=')[1] ?? '') } : {}) }, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
  const text = await res.text();
  let body: any = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, setCookies: res.headers.getSetCookie() };
}
async function upload(p: string, cookie: string): Promise<HttpResult> {
  const form = new FormData(); form.append('photo', new Blob([new Uint8Array(PNG)], { type: 'image/png' }), 'f.png');
  const res = await fetch(`${baseUrl}${p}`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrfTokenFor(cookie.split('=')[1] ?? '') }, body: form });
  return { status: res.status, body: JSON.parse((await res.text()) || 'null'), setCookies: [] };
}
async function uploadSig(jobId: number, cookie: string): Promise<HttpResult> {
  const form = new FormData(); form.append('signature', new Blob([new Uint8Array(PNG)], { type: 'image/png' }), 'sig.png');
  const res = await fetch(`${baseUrl}/api/v1/jobs/${jobId}/signature`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrfTokenFor(cookie.split('=')[1] ?? '') }, body: form });
  return { status: res.status, body: JSON.parse((await res.text()) || 'null'), setCookies: [] };
}
async function login(phone: string): Promise<string> { const r = await http('POST', '/api/v1/auth/login', { body: { phone, password: PASSWORD, rememberMe: false } }); assert.equal(r.status, 200, `login ${phone}`); return r.setCookies.find((c) => c.startsWith('eg_session='))!.split(';')[0]; }
let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> { try { await fn(); passed += 1; console.log(`  PASS  ${name}`); } catch (err) { failed += 1; console.error(`  FAIL  ${name}`); console.error(`        ${err instanceof Error ? err.stack : String(err)}`); } }

async function cleanup(): Promise<void> {
  const jobIds = (await db('jobs').join('vehicles', 'vehicles.id', 'jobs.vehicle_id').where('vehicles.plate_number', 'like', 'TSNP%').select('jobs.id')).map((j: { id: number }) => j.id);
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
  const tplIds = (await db('checklist_templates').where('name', 'like', 'TEST SNP%').select('id')).map((t: { id: number }) => t.id);
  if (tplIds.length > 0) { const vIds = (await db('checklist_template_versions').whereIn('template_id', tplIds).select('id')).map((v: { id: number }) => v.id); if (vIds.length > 0) { const sIds = (await db('checklist_steps').whereIn('version_id', vIds).select('id')).map((s: { id: number }) => s.id); if (sIds.length > 0) { await db('checklist_step_measurements').whereIn('step_id', sIds).del(); await db('checklist_steps').whereIn('id', sIds).del(); } await db('checklist_template_versions').whereIn('id', vIds).del(); } await db('checklist_templates').whereIn('id', tplIds).del(); }
  const custIds = (await db('customers').where('name', 'like', 'TEST SNP%').select('id')).map((c: { id: number }) => c.id);
  await db('vehicles').where('plate_number', 'like', 'TSNP%').del();
  if (custIds.length > 0) await db('customers').whereIn('id', custIds).del();
  const users = await db('users').whereIn('phone', Object.values(USERS)).select('id');
  const uids = users.map((u: { id: number }) => u.id);
  if (uids.length > 0) { await db('audit_logs').whereIn('user_id', uids).del(); await db('sessions').whereIn('user_id', uids).del(); }
  await db('users').whereIn('phone', Object.values(USERS)).del();
  await db('branches').where('name', 'like', 'TEST SNP%').del();
}

async function run(): Promise<void> {
  setSmsProviderForTesting({ name: 'test-capture', send: async () => ({ providerMessageId: null, outcome: 'ACCEPTED' as const }) });
  storage = new MemoryStorageProvider();
  setStorageProviderForTesting(storage);
  await assertTestDatabase(db);
  await cleanup();

  const roles = await db('roles').select('id', 'code');
  const roleId = (c: string) => roles.find((r: { code: string }) => r.code === c)?.id;
  const [branchA] = await db('branches').insert({ name: 'TEST SNP Branch A', region: 'Toshkent shahri', status: 'ACTIVE' });
  const pw = await bcrypt.hash(PASSWORD, 10);
  const b = { password_hash: pw, region: 'Toshkent shahri', status: 'ACTIVE' };
  const ins = async (r: Record<string, unknown>) => (await db('users').insert(r))[0] as number;
  const ids: Record<string, number> = {};
  ids.admin = await ins({ ...b, first_name: 'Snp', last_name: 'Admin', phone: USERS.admin, branch_id: null, role_id: roleId('ADMIN') });
  ids.ustaA = await ins({ ...b, first_name: 'Snp', last_name: 'UstaA', phone: USERS.ustaA, branch_id: branchA, role_id: roleId('USTA') });
  ids.master = await ins({ ...b, first_name: 'Snp', last_name: 'Master', phone: USERS.master, branch_id: branchA, role_id: roleId('MASTER') });
  ids.ustaA2 = await ins({ ...b, first_name: 'Snp', last_name: 'UstaA2', phone: USERS.ustaA2, branch_id: branchA, role_id: roleId('USTA') });
  ids.sifat = await ins({ ...b, first_name: 'Snp', last_name: 'Sifat', phone: USERS.sifat, branch_id: null, role_id: roleId('SIFAT') });

  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  console.log(`\nRunning snapshot E2E against ${baseUrl}\n`);

  const usta = await login(USERS.ustaA);
  const master = await login(USERS.master);
  const sifat = await login(USERS.sifat);
  const admin = await login(USERS.admin);

  const c = await http('POST', '/api/v1/customers', { cookie: usta, body: { name: 'TEST SNP Mijoz', phone: '99 000 96 11' } });
  const customerId = c.body.customer.id as number;
  const t = await http('POST', '/api/v1/checklist-templates', { cookie: admin, body: { name: 'TEST SNP Shablon' } });
  const templateId = t.body.template.id;
  const versionId = t.body.template.versions[0].id;
  for (const step of [{ name: 'Tayyorgarlik' }, { name: "O'lchov", requiredPhotos: 1, measurements: [{ name: 'Bosim', unit: 'bar', minValue: 10, maxValue: 20, required: true }] }, { name: 'STOP', isStop: true, requiredPhotos: 1 }]) {
    await http('POST', `/api/v1/checklist-templates/${templateId}/versions/${versionId}/steps`, { cookie: admin, body: step });
  }
  await http('POST', `/api/v1/checklist-templates/${templateId}/versions/${versionId}/publish`, { cookie: admin });

  let plate = 0;
  const mkJob = async () => {
    const p = `TSNP${String(++plate).padStart(3, '0')}`;
    const v = await http('POST', '/api/v1/vehicles', { cookie: usta, body: { customerId, plateNumber: p, make: 'Chevrolet', model: 'Spark' } });
    const j = await http('POST', '/api/v1/jobs', { cookie: usta, body: { customerId, vehicleId: v.body.vehicle.id } });
    const jobId = j.body.job.id as number;
    await http('POST', `/api/v1/jobs/${jobId}/start`, { cookie: usta });
    const a = await http('POST', `/api/v1/jobs/${jobId}/checklist`, { cookie: usta, body: { templateId } });
    return { jobId, vehicleId: v.body.vehicle.id as number, steps: a.body.checklist.steps as any[] };
  };
  const stepPath = (jobId: number, stepId: number) => `/api/v1/jobs/${jobId}/checklist/steps/${stepId}/photos`;
  const complete = (jobId: number, stepId: number, body: any = {}) => http('POST', `/api/v1/jobs/${jobId}/checklist/steps/${stepId}/complete`, { cookie: usta, body });
  const close = (jobId: number, cookie = master) => http('POST', `/api/v1/jobs/${jobId}/complete`, { cookie });
  const driveToSigned = async (job: { jobId: number; steps: any[] }) => {
    await complete(job.jobId, job.steps[0].id);
    await upload(stepPath(job.jobId, job.steps[1].id), usta);
    await complete(job.jobId, job.steps[1].id, { measurements: [{ measurementId: job.steps[1].measurements[0].id, value: 15 }] });
    await upload(stepPath(job.jobId, job.steps[2].id), usta);
    await complete(job.jobId, job.steps[2].id);
    await http('POST', `/api/v1/jobs/${job.jobId}/stop/approve`, { cookie: master });
    assert.equal((await uploadSig(job.jobId, usta)).status, 201);
  };

  // ---- L19: canonical serialization determinism ----
  await test('L19: canonical serialization is deterministic and key-order independent', async () => {
    const a = { b: 1, a: [3, 2, 1], c: { z: 'x', y: null } };
    const b = { c: { y: null, z: 'x' }, a: [3, 2, 1], b: 1 };
    assert.equal(canonicalStringify(a), canonicalStringify(b), 'key order does not affect canonical form');
    assert.equal(digestOf(a), digestOf(b));
    // Array order IS significant.
    assert.notEqual(digestOf({ a: [1, 2] }), digestOf({ a: [2, 1] }));
  });

  // ---- L22: signable summary digest sensitivity ----
  await test('L22: the signable-summary digest changes when a material field changes', async () => {
    const job = await mkJob();
    const s1 = await http('GET', `/api/v1/jobs/${job.jobId}/signable-summary`, { cookie: usta });
    assert.equal(s1.status, 200);
    assert.match(s1.body.digest, /^[0-9a-f]{64}$/);
    // Reassign the responsible technician → material change → different digest.
    await http('POST', `/api/v1/jobs/${job.jobId}/assign`, { cookie: master, body: { technicianId: ids.ustaA2 } });
    const s2 = await http('GET', `/api/v1/jobs/${job.jobId}/signable-summary`, { cookie: usta });
    assert.notEqual(s2.body.digest, s1.body.digest, 'assignee change alters the digest');
  });

  // ---- F: completion snapshot is finalized on close ----
  await test('F: closing finalizes an immutable completion snapshot with a digest + identity', async () => {
    const job = await mkJob();
    await driveToSigned(job);
    assert.equal((await close(job.jobId)).status, 200);
    const snap = await http('GET', `/api/v1/jobs/${job.jobId}/completion-snapshot`, { cookie: master });
    assert.equal(snap.status, 200, JSON.stringify(snap.body));
    assert.match(snap.body.digest, /^[0-9a-f]{64}$/);
    assert.equal(snap.body.provenance, 'FINALIZED');
    assert.equal(snap.body.schemaVersion, 'snapshot-v1');
    assert.ok(snap.body.content.summary.customer, 'customer identity embedded');
    assert.ok(snap.body.content.summary.customer.phoneMasked.startsWith('***'), 'phone masked in snapshot');
    assert.ok(snap.body.content.signature?.sha256, 'signature hash bound');
    // The stored content digest recomputes deterministically.
    assert.equal(digestOf(snap.body.content), snap.body.digest);
  });

  // ---- L17/L18: completed history is frozen against later customer/vehicle edits ----
  await test('L17/L18: editing the customer or vehicle later does not change the completed snapshot', async () => {
    const job = await mkJob();
    await driveToSigned(job);
    assert.equal((await close(job.jobId)).status, 200);
    const before = await http('GET', `/api/v1/jobs/${job.jobId}/completion-snapshot`, { cookie: master });
    // Edit the live customer + vehicle.
    await http('PATCH', `/api/v1/customers/${customerId}`, { cookie: usta, body: { name: 'TEST SNP Mijoz OZGARDI' } });
    await http('PATCH', `/api/v1/vehicles/${job.vehicleId}`, { cookie: usta, body: { make: 'Daewoo' } });
    const after = await http('GET', `/api/v1/jobs/${job.jobId}/completion-snapshot`, { cookie: master });
    assert.equal(after.body.digest, before.body.digest, 'snapshot digest unchanged after live edits');
    assert.equal(after.body.content.summary.customer.name, before.body.content.summary.customer.name, 'snapshot keeps the historical name');
  });

  // ---- L20: retry returns the same snapshot; re-close is refused ----
  await test('L20: completion retry returns the same snapshot; a second close is refused', async () => {
    const job = await mkJob();
    await driveToSigned(job);
    assert.equal((await close(job.jobId)).status, 200);
    const s1 = await http('GET', `/api/v1/jobs/${job.jobId}/completion-snapshot`, { cookie: master });
    const reClose = await close(job.jobId);
    assert.notEqual(reClose.status, 200, 'a completed job cannot be re-closed');
    const s2 = await http('GET', `/api/v1/jobs/${job.jobId}/completion-snapshot`, { cookie: master });
    assert.equal(s2.body.digest, s1.body.digest, 'same immutable snapshot');
    assert.equal((await db('completion_snapshots').where({ job_id: job.jobId })).length, 1, 'exactly one snapshot');
  });

  // ---- L21: snapshot uniqueness under concurrent close ----
  await test('L21: two concurrent closes yield exactly one snapshot', async () => {
    const job = await mkJob();
    await driveToSigned(job);
    const [a, bb] = await Promise.all([close(job.jobId), close(job.jobId)]);
    const oks = [a, bb].filter((r) => r.status === 200).length;
    assert.equal(oks, 1, 'exactly one close succeeds');
    assert.equal((await db('completion_snapshots').where({ job_id: job.jobId })).length, 1);
  });

  // ---- L23/L24: stale signature prevents close; re-sign permits it ----
  await test('L23/L24: a material change staled the signature (close blocked); re-sign permits close', async () => {
    const job = await mkJob();
    await driveToSigned(job); // signed, closeable
    // Reassign after signing → the accepted summary no longer matches.
    await http('POST', `/api/v1/jobs/${job.jobId}/assign`, { cookie: master, body: { technicianId: ids.ustaA2 } });
    const stale = await close(job.jobId);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'SIGNATURE_STALE');
    // Re-sign (new immutable record; the stale one is superseded, never overwritten).
    const before = (await db('customer_signatures').where({ job_id: job.jobId })).length;
    assert.equal((await uploadSig(job.jobId, master)).status, 201);
    assert.equal((await db('customer_signatures').where({ job_id: job.jobId })).length, before + 1, 'a new signature record was created');
    assert.equal((await db('customer_signatures').where({ job_id: job.jobId }).whereNotNull('superseded_at')).length >= 1, true, 'the stale signature is superseded, not deleted');
    assert.equal((await close(job.jobId)).status, 200, 're-signed → close proceeds');
  });

  // ---- L25: reopen requires a new signature + a new snapshot per cycle ----
  await test('L25: reopen requires a fresh signature and finalizes a separate cycle-2 snapshot', async () => {
    const job = await mkJob();
    await driveToSigned(job);
    assert.equal((await close(job.jobId)).status, 200);
    assert.equal((await http('POST', `/api/v1/jobs/${job.jobId}/reopen`, { cookie: sifat, body: { reason: 'qayta korish' } })).status, 200);
    // Without a cycle-2 signature the reopened close is blocked.
    assert.equal((await close(job.jobId)).status, 422);
    assert.equal((await uploadSig(job.jobId, usta)).status, 201);
    assert.equal((await close(job.jobId)).status, 200); // → QUALITY_REVIEW
    assert.equal((await http('POST', `/api/v1/jobs/${job.jobId}/quality/confirm`, { cookie: sifat })).status, 200); // COMPLETED cycle 2
    const snaps = await db('completion_snapshots').where({ job_id: job.jobId }).orderBy('cycle');
    assert.equal(snaps.length, 2, 'one snapshot per completed cycle');
    assert.notEqual(snaps[0].digest, snaps[1].digest);
  });

  await cleanup();
  server.close();
  await db.destroy();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

run().catch(async (err) => { console.error(err); try { await db.destroy(); } catch { /* ignore */ } process.exit(1); });
