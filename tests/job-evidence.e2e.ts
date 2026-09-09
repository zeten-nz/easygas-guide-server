/**
 * EASY GAS — Phase 11C job-level photo-EVIDENCE listing (read-only).
 *
 *   npm run test:job-evidence   (after: npm run test:setup)
 *
 * Builds a REAL completed job (via the workflow services) that is then reopened and
 * re-worked across attempts, plus realistic legacy/failed evidence rows, and
 * verifies GET /jobs/:id/photos: truthful per-photo provenance (cycle derived only
 * from the immutable snapshot; role COMPLETED_CYCLE / CURRENT / SUPERSEDED_ATTEMPT /
 * UNVERIFIED / FAILED), bounded pagination, the cycle filter, branch isolation
 * (out-of-scope → 404), the forced-password-change gate, and that only READY rows
 * are downloadable through the existing step file endpoint (no bypass).
 *
 * Fixtures: users +99899000960x, "TEST JE ..." names, TJE* plates.
 */
import { assertTestDatabase } from './helpers/test-env';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import { db } from '../src/config/database';
import { createApp } from '../src/app';
import { setSmsProviderForTesting } from '../src/sms';
import { setStorageProviderForTesting } from '../src/storage';
import { MemoryStorageProvider } from './helpers/memory-storage';
import { ROLE_PERMISSIONS } from '../src/rbac/permissions';
import type { AuthUser, RoleCode } from '../src/types/auth';
import * as jobsService from '../src/modules/jobs/jobs.service';
import * as execution from '../src/modules/checklist/execution.service';
import * as photos from '../src/modules/photos/photos.service';
import * as completion from '../src/modules/jobs/completion.service';
import { createTemplate, addStep, publishVersion } from '../src/modules/checklist/templates.service';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const USERS = { admin: '+998990009601', usta: '+998990009602', master: '+998990009603', sifat: '+998990009604', ustaB: '+998990009605' };
const PASSWORD = 'Sinov-parol-123';
const META = { ip: null, userAgent: null };

let baseUrl = '';
interface HttpResult { status: number; body: any; setCookies: string[]; headers: Headers }
async function http(method: string, p: string, opts: { cookie?: string } = {}): Promise<HttpResult> {
  const res = await fetch(`${baseUrl}${p}`, { method, headers: { ...(opts.cookie ? { cookie: opts.cookie } : {}) } });
  const text = await res.text(); let body: any = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, setCookies: res.headers.getSetCookie(), headers: res.headers };
}
async function login(phone: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, password: PASSWORD, rememberMe: false }) });
  assert.equal(res.status, 200, `login ${phone}`);
  return res.headers.getSetCookie().find((c) => c.startsWith('eg_session='))!.split(';')[0];
}
let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> { try { await fn(); passed += 1; console.log(`  PASS  ${name}`); } catch (err) { failed += 1; console.error(`  FAIL  ${name}`); console.error(`        ${err instanceof Error ? err.stack : String(err)}`); } }

function actorFrom(row: Record<string, any>, role: RoleCode): AuthUser {
  return { id: row.id, firstName: row.first_name, lastName: row.last_name, phone: row.phone, region: row.region, branchId: row.branch_id ?? null, role, status: 'ACTIVE', avatarUrl: null, mustChangePassword: false, permissions: ROLE_PERMISSIONS[role] };
}

async function cleanup(): Promise<void> {
  const jobIds = (await db('jobs').join('vehicles', 'vehicles.id', 'jobs.vehicle_id').where('vehicles.plate_number', 'like', 'TJE%').select('jobs.id')).map((j: { id: number }) => j.id);
  if (jobIds.length > 0) {
    await db('risk_events').whereIn('job_id', jobIds).del();
    await db('completion_snapshots').whereIn('job_id', jobIds).del();
    await db('customer_signatures').whereIn('job_id', jobIds).del();
    await db('job_photos').whereIn('job_id', jobIds).del();
    await db('job_assignments').whereIn('job_id', jobIds).del();
    const clIds = (await db('job_checklists').whereIn('job_id', jobIds).select('id')).map((c: { id: number }) => c.id);
    if (clIds.length > 0) { const sIds = (await db('job_steps').whereIn('job_checklist_id', clIds).select('id')).map((s: { id: number }) => s.id); if (sIds.length) { await db('step_measurements').whereIn('job_step_id', sIds).del(); await db('stop_approvals').whereIn('job_step_id', sIds).del(); await db('job_steps').whereIn('id', sIds).del(); } await db('job_checklists').whereIn('id', clIds).del(); }
    await db('audit_logs').whereIn('entity_type', ['job']).whereIn('entity_id', jobIds.map(String)).del();
    await db('jobs').whereIn('id', jobIds).del();
  }
  await db('vehicles').where('plate_number', 'like', 'TJE%').del();
  await db('customers').where('name', 'like', 'TEST JE%').del();
  const tpls = (await db('checklist_templates').where('name', 'like', 'TEST JE%').select('id')).map((t: { id: number }) => t.id);
  if (tpls.length) { const vers = (await db('checklist_template_versions').whereIn('template_id', tpls).select('id')).map((v: { id: number }) => v.id); if (vers.length) { await db('checklist_steps').whereIn('version_id', vers).del(); await db('checklist_template_versions').whereIn('id', vers).del(); } await db('checklist_templates').whereIn('id', tpls).del(); }
  const users = await db('users').whereIn('phone', Object.values(USERS)).select('id');
  const uids = users.map((u: { id: number }) => u.id);
  if (uids.length) { await db('audit_logs').whereIn('user_id', uids).del(); await db('sessions').whereIn('user_id', uids).del(); }
  await db('users').whereIn('phone', Object.values(USERS)).del();
  await db('branches').where('name', 'like', 'TEST JE%').del();
}

async function run(): Promise<void> {
  setSmsProviderForTesting({ name: 'test-capture', send: async () => ({ providerMessageId: null, outcome: 'ACCEPTED' as const }) });
  setStorageProviderForTesting(new MemoryStorageProvider());
  await assertTestDatabase(db);
  await cleanup();

  const roles = await db('roles').select('id', 'code');
  const roleId = (c: string) => roles.find((r: { code: string }) => r.code === c)?.id;
  const [branchA] = await db('branches').insert({ name: 'TEST JE Branch A', region: 'Toshkent shahri', status: 'ACTIVE' });
  const [branchB] = await db('branches').insert({ name: 'TEST JE Branch B', region: 'Toshkent shahri', status: 'ACTIVE' });
  const pw = await bcrypt.hash(PASSWORD, 10);
  const base = { password_hash: pw, region: 'Toshkent shahri', status: 'ACTIVE' };
  const ins = async (r: Record<string, unknown>) => (await db('users').insert(r))[0] as number;
  await ins({ ...base, first_name: 'Je', last_name: 'Admin', phone: USERS.admin, branch_id: null, role_id: roleId('ADMIN') });
  await ins({ ...base, first_name: 'Je', last_name: 'Usta', phone: USERS.usta, branch_id: branchA, role_id: roleId('USTA') });
  await ins({ ...base, first_name: 'Je', last_name: 'Master', phone: USERS.master, branch_id: branchA, role_id: roleId('MASTER') });
  await ins({ ...base, first_name: 'Je', last_name: 'Sifat', phone: USERS.sifat, branch_id: null, role_id: roleId('SIFAT') });
  await ins({ ...base, first_name: 'Je', last_name: 'UstaB', phone: USERS.ustaB, branch_id: branchB, role_id: roleId('USTA') });

  const ustaRow = await db('users').where({ phone: USERS.usta }).first();
  const masterRow = await db('users').where({ phone: USERS.master }).first();
  const sifatRow = await db('users').where({ phone: USERS.sifat }).first();
  const usta = actorFrom(ustaRow, 'USTA');
  const master = actorFrom(masterRow, 'MASTER');
  const sifat = actorFrom(sifatRow, 'SIFAT');

  // --- Build a REAL completed job with evidence, then reopen + re-work it. ---
  const [customerId] = await db('customers').insert({ name: 'TEST JE Mijoz', phone: '+998900000960', created_by: ustaRow.id });
  const [vehicleId] = await db('vehicles').insert({ customer_id: customerId, plate_number: 'TJE001', make: 'Chevrolet', model: 'Spark', created_by: ustaRow.id });
  const [jobId] = await db('jobs').insert({ customer_id: customerId, vehicle_id: vehicleId, branch_id: branchA, status: 'DRAFT', created_by: ustaRow.id, assigned_technician_id: ustaRow.id, assignment_status: 'ASSIGNED', cycle: 1 });
  await db('job_assignments').insert({ job_id: jobId, cycle: 1, technician_id: ustaRow.id, assigned_by: ustaRow.id, provenance: 'SELF_AT_CREATION' });

  const tpl = await createTemplate(usta, { name: 'TEST JE Checklist', description: 'evidence test' }, META);
  const versionId = tpl.versions[0].id;
  await addStep(usta, tpl.id, versionId, { name: 'JE Step One', isStop: false, riskWeight: 0, requiredPhotos: 0, measurements: [] }, META);
  await publishVersion(usta, tpl.id, versionId, META);

  await jobsService.startJob(usta, jobId, META);
  await execution.assignChecklist(usta, jobId, tpl.id, META);
  const step1 = await db('job_steps').join('job_checklists', 'job_checklists.id', 'job_steps.job_checklist_id').where('job_checklists.job_id', jobId).select('job_steps.id').first();
  const stepId = step1.id as number;

  // Cycle 1: upload P1, complete, sign, close.
  const p1 = await photos.uploadStepPhoto(usta, jobId, stepId, { buffer: PNG, originalname: 'c1.png' }, META);
  await execution.completeStep(usta, jobId, stepId, { measurements: [] }, META);
  const sum1 = await completion.getSignableSummary(jobId);
  await completion.saveSignature(usta, jobId, { buffer: PNG }, META, sum1!.digest);
  await completion.closeJob(master, jobId, META);
  let job = await db('jobs').where({ id: jobId }).first();
  assert.equal(job.status, 'COMPLETED');
  assert.equal(job.cycle, 1);

  // Reopen → cycle 2 working. Redo the step twice so we get: P1(snapshot cycle1),
  // P2(superseded attempt), P3(current attempt), all through the REAL workflow.
  await completion.reopenJob(sifat, jobId, 'tuzatish kerak', META);
  await execution.redoStep(usta, jobId, stepId, META); // attempt 2 (assigned technician)
  const p2 = await photos.uploadStepPhoto(usta, jobId, stepId, { buffer: PNG, originalname: 'c2a.png' }, META);
  await execution.completeStep(usta, jobId, stepId, { measurements: [] }, META);
  await execution.redoStep(usta, jobId, stepId, META); // attempt 3
  const p3 = await photos.uploadStepPhoto(usta, jobId, stepId, { buffer: PNG, originalname: 'c2b.png' }, META);
  job = await db('jobs').where({ id: jobId }).first();
  assert.equal(job.status, 'REOPENED');
  assert.equal(job.cycle, 2);

  // Realistic non-READY rows that co-exist in the same table (legacy migration
  // backfill = UNVERIFIED; a failed upload = FAILED). We insert these directly to
  // exercise the LISTING's handling of these states — the job itself is real.
  const [legacyId] = await db('job_photos').insert({ job_id: jobId, job_step_id: stepId, attempt: 1, status: 'UNVERIFIED', storage_key: `photos/${jobId}/${stepId}/legacy.png`, original_name: 'legacy.png', mime_type: 'image/png', content_type: 'image/png', size_bytes: PNG.length, hash: 'deadbeef', created_by: ustaRow.id });
  await db('job_photos').insert({ job_id: jobId, job_step_id: stepId, attempt: 3, status: 'FAILED', failure_reason: 'STORAGE_IO', storage_key: `photos/${jobId}/${stepId}/failed.png`, original_name: 'failed.png', mime_type: 'image/png', content_type: 'image/png', size_bytes: PNG.length, hash: 'cafe', created_by: ustaRow.id });

  // --- Job B: a photo referenced by MULTIPLE snapshots. Complete cycle 1, reopen,
  // re-close WITHOUT redoing the step → its attempt-1 photo is frozen into BOTH the
  // cycle-1 and cycle-2 snapshots (a step not re-done carries the same evidence). ---
  const buildJob = async (plate: string): Promise<{ id: number; step: number }> => {
    const [vid] = await db('vehicles').insert({ customer_id: customerId, plate_number: plate, make: 'Chevrolet', model: 'Onix', created_by: ustaRow.id });
    const [id] = await db('jobs').insert({ customer_id: customerId, vehicle_id: vid, branch_id: branchA, status: 'DRAFT', created_by: ustaRow.id, assigned_technician_id: ustaRow.id, assignment_status: 'ASSIGNED', cycle: 1 });
    await db('job_assignments').insert({ job_id: id, cycle: 1, technician_id: ustaRow.id, assigned_by: ustaRow.id, provenance: 'SELF_AT_CREATION' });
    await jobsService.startJob(usta, id, META);
    await execution.assignChecklist(usta, id, tpl.id, META);
    const step = (await db('job_steps').join('job_checklists', 'job_checklists.id', 'job_steps.job_checklist_id').where('job_checklists.job_id', id).select('job_steps.id').first()).id as number;
    return { id, step };
  };
  const jobB = await buildJob('TJE002');
  const pB = await photos.uploadStepPhoto(usta, jobB.id, jobB.step, { buffer: PNG, originalname: 'b1.png' }, META);
  await execution.completeStep(usta, jobB.id, jobB.step, { measurements: [] }, META);
  await completion.saveSignature(usta, jobB.id, { buffer: PNG }, META, (await completion.getSignableSummary(jobB.id))!.digest);
  await completion.closeJob(master, jobB.id, META); // COMPLETED cycle 1 → snapshot 1 (pB)
  await completion.reopenJob(sifat, jobB.id, "qayta ko'rish", META); // REOPENED cycle 2 — step NOT redone
  await completion.saveSignature(usta, jobB.id, { buffer: PNG }, META, (await completion.getSignableSummary(jobB.id))!.digest);
  await completion.closeJob(master, jobB.id, META); // REOPENED → QUALITY_REVIEW (no snapshot yet)
  await completion.confirmQuality(sifat, jobB.id, META); // QUALITY_REVIEW → COMPLETED cycle 2 → snapshot 2 (pB again)
  const jobBRow = await db('jobs').where({ id: jobB.id }).first();
  assert.equal(jobBRow.status, 'COMPLETED'); assert.equal(jobBRow.cycle, 2);
  assert.equal(Number((await db('completion_snapshots').where({ job_id: jobB.id }).count({ c: '*' }))[0].c), 2, 'two snapshots');

  // --- Job C: a CANCELLED job with READY evidence → HISTORICAL_UNCLASSIFIED
  // (not snapshotted, not workable, not a strictly-earlier attempt). ---
  const jobC = await buildJob('TJE003');
  const pC = await photos.uploadStepPhoto(usta, jobC.id, jobC.step, { buffer: PNG, originalname: 'c.png' }, META);
  await jobsService.cancelJob(usta, jobC.id, 'mijoz voz kechdi', META);
  assert.equal((await db('jobs').where({ id: jobC.id }).first()).status, 'CANCELLED');

  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  console.log(`\nRunning job-evidence E2E against ${baseUrl}\n`);

  const ustaCookie = await login(USERS.usta);
  const ustaBCookie = await login(USERS.ustaB);

  await test('lists all evidence with truthful roles (COMPLETED_CYCLE / SUPERSEDED_ATTEMPT / CURRENT / UNVERIFIED / FAILED)', async () => {
    const r = await http('GET', `/api/v1/jobs/${jobId}/photos?limit=100`, { cookie: ustaCookie });
    assert.equal(r.status, 200);
    assert.equal(r.body.job.cycle, 2);
    assert.equal(r.body.job.assignedTechnicianId, ustaRow.id);
    const byId = new Map<number, any>(r.body.photos.map((p: any) => [p.id, p]));
    assert.equal(byId.get(p1.id).role, 'COMPLETED_CYCLE');
    assert.equal(byId.get(p1.id).cycle, 1);
    assert.equal(byId.get(p1.id).snapshotEvidence, true);
    assert.equal(byId.get(p1.id).downloadable, true);
    assert.equal(byId.get(p2.id).role, 'SUPERSEDED_ATTEMPT');
    assert.equal(byId.get(p2.id).cycle, null);
    assert.equal(byId.get(p3.id).role, 'CURRENT');
    assert.equal(byId.get(p3.id).cycle, null);
    assert.equal(byId.get(legacyId).role, 'UNVERIFIED');
    assert.equal(byId.get(legacyId).downloadable, false);
    const failed = r.body.photos.find((p: any) => p.status === 'FAILED');
    assert.equal(failed.role, 'FAILED');
    assert.equal(failed.downloadable, false);
    // Uploader is the actual performer, not merely the assigned technician label.
    assert.equal(byId.get(p1.id).uploadedByName, 'Je Usta');
    // Cycles list comes from the immutable snapshot(s).
    assert.ok(r.body.cycles.some((c: any) => c.cycle === 1 && c.provenance === 'FINALIZED'));
  });

  await test('cycle filter returns exactly the snapshot evidence of that cycle', async () => {
    const r = await http('GET', `/api/v1/jobs/${jobId}/photos?cycle=1`, { cookie: ustaCookie });
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 1);
    assert.equal(r.body.photos[0].id, p1.id);
    assert.equal(r.body.photos[0].role, 'COMPLETED_CYCLE');
  });

  await test('pagination is bounded (limit honoured, total accurate)', async () => {
    const r = await http('GET', `/api/v1/jobs/${jobId}/photos?limit=2&page=1`, { cookie: ustaCookie });
    assert.equal(r.status, 200);
    assert.equal(r.body.photos.length, 2);
    assert.equal(r.body.total, 5); // P1,P2,P3,legacy,failed
    assert.equal(r.body.limit, 2);
  });

  await test('branch isolation — another branch cannot list or reach the job (404, not 403)', async () => {
    assert.equal((await http('GET', `/api/v1/jobs/${jobId}/photos`, { cookie: ustaBCookie })).status, 404);
  });

  await test('only READY photos are downloadable via the existing step file endpoint', async () => {
    const ok = await http('GET', `/api/v1/jobs/${jobId}/checklist/steps/${stepId}/photos/${p1.id}/file`, { cookie: ustaCookie });
    assert.equal(ok.status, 200);
    // UNVERIFIED legacy row is NOT served (the endpoint only serves READY).
    assert.equal((await http('GET', `/api/v1/jobs/${jobId}/checklist/steps/${stepId}/photos/${legacyId}/file`, { cookie: ustaCookie })).status, 404);
    // Cross-branch download refused (404).
    assert.equal((await http('GET', `/api/v1/jobs/${jobId}/checklist/steps/${stepId}/photos/${p1.id}/file`, { cookie: ustaBCookie })).status, 404);
  });

  await test('a photo referenced by MULTIPLE snapshots reports all cycles (spans cycle 1 and 2)', async () => {
    const all = await http('GET', `/api/v1/jobs/${jobB.id}/photos?limit=100`, { cookie: ustaCookie });
    assert.equal(all.status, 200);
    const photo = all.body.photos.find((p: any) => p.id === pB.id);
    assert.ok(photo, 'the shared photo is listed');
    assert.equal(photo.role, 'COMPLETED_CYCLE');
    assert.deepEqual(photo.cycles, [1, 2], 'recorded for BOTH completed cycles');
    assert.equal(photo.cycle, 2, 'primary = latest cycle');
    assert.equal(photo.snapshotEvidence, true);
    // The cycle filter includes the shared photo for EITHER cycle.
    const c1 = await http('GET', `/api/v1/jobs/${jobB.id}/photos?cycle=1`, { cookie: ustaCookie });
    assert.ok(c1.body.photos.some((p: any) => p.id === pB.id), 'cycle 1 includes it');
    const c2 = await http('GET', `/api/v1/jobs/${jobB.id}/photos?cycle=2`, { cookie: ustaCookie });
    assert.ok(c2.body.photos.some((p: any) => p.id === pB.id), 'cycle 2 includes it');
  });

  await test("cancelled-job READY evidence is HISTORICAL_UNCLASSIFIED (honest unknown, never 'current')", async () => {
    const r = await http('GET', `/api/v1/jobs/${jobC.id}/photos?limit=100`, { cookie: ustaCookie });
    assert.equal(r.status, 200);
    const photo = r.body.photos.find((p: any) => p.id === pC.id);
    assert.ok(photo, 'the cancelled-job photo is listed');
    assert.equal(photo.role, 'HISTORICAL_UNCLASSIFIED');
    assert.equal(photo.cycle, null);
    assert.deepEqual(photo.cycles, []);
    assert.equal(photo.downloadable, true); // still READY, still viewable
  });

  await test('direct historical-file access is branch-authorized (a completed-cycle photo, cross-branch → 404)', async () => {
    // In-branch actor can stream the READY completed-cycle photo.
    assert.equal((await http('GET', `/api/v1/jobs/${jobB.id}/checklist/steps/${jobB.step}/photos/${pB.id}/file`, { cookie: ustaCookie })).status, 200);
    // Another branch cannot reach it (404, not 403) — a frontend-hidden link is not access control.
    assert.equal((await http('GET', `/api/v1/jobs/${jobB.id}/checklist/steps/${jobB.step}/photos/${pB.id}/file`, { cookie: ustaBCookie })).status, 404);
  });

  await test('responsible-technician filter list is branch-scoped, searchable and id-resolvable', async () => {
    // usta (branchA) is the responsible technician on jobs in branchA → listed.
    const listed = await http('GET', '/api/v1/jobs/technicians', { cookie: ustaCookie });
    assert.equal(listed.status, 200);
    assert.ok(listed.body.items.some((t: any) => t.id === ustaRow.id), 'usta listed (has jobs in scope)');
    // Name search.
    const searched = await http('GET', `/api/v1/jobs/technicians?search=${encodeURIComponent(ustaRow.first_name)}`, { cookie: ustaCookie });
    assert.ok(searched.body.items.some((t: any) => t.id === ustaRow.id), 'found by name');
    // Resolve one by id (drives the "selected name after reload" display).
    const byId = await http('GET', `/api/v1/jobs/technicians?id=${ustaRow.id}`, { cookie: ustaCookie });
    assert.equal(byId.body.items.length, 1);
    assert.equal(byId.body.items[0].name, 'Je Usta');
    // Branch scope: another branch cannot resolve/list a branch-A technician.
    const crossBranch = await http('GET', `/api/v1/jobs/technicians?id=${ustaRow.id}`, { cookie: ustaBCookie });
    assert.equal(crossBranch.body.items.length, 0, 'cross-branch technician not resolvable');
  });

  await test('completed-job list filters — technician, status and date range (additive, allowlisted)', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const future = '2999-01-01';
    const byTech = await http('GET', `/api/v1/jobs?technicianId=${ustaRow.id}&limit=100`, { cookie: ustaCookie });
    assert.equal(byTech.status, 200);
    assert.ok(byTech.body.jobs.some((j: any) => j.id === jobId), 'technician filter includes the job');
    const byStatus = await http('GET', `/api/v1/jobs?status=REOPENED&limit=100`, { cookie: ustaCookie });
    assert.ok(byStatus.body.jobs.some((j: any) => j.id === jobId), 'status filter includes the reopened job');
    const inRange = await http('GET', `/api/v1/jobs?dateFrom=${today}&dateTo=${today}&limit=100`, { cookie: ustaCookie });
    assert.ok(inRange.body.jobs.some((j: any) => j.id === jobId), 'today range includes the job');
    const futureOnly = await http('GET', `/api/v1/jobs?dateFrom=${future}&limit=100`, { cookie: ustaCookie });
    assert.ok(!futureOnly.body.jobs.some((j: any) => j.id === jobId), 'future dateFrom excludes the job');
  });

  await test('the forced-password-change gate blocks the evidence listing', async () => {
    await db('users').where({ id: ustaRow.id }).update({ must_change_password: true });
    const forced = await login(USERS.usta);
    const r = await http('GET', `/api/v1/jobs/${jobId}/photos`, { cookie: forced });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'PASSWORD_CHANGE_REQUIRED');
    await db('users').where({ id: ustaRow.id }).update({ must_change_password: false });
  });

  server.close();
  await cleanup();
  console.log(`\njob-evidence: ${passed} passed, ${failed} failed\n`);
  await db.destroy();
  if (failed > 0) process.exitCode = 1;
}

run().catch(async (err) => { console.error(err); try { await db.destroy(); } catch { /* ignore */ } process.exit(1); });
