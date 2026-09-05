/**
 * EASY GAS — Phase 10D risk-matrix GOVERNANCE.
 *
 *   npm run test:riskpolicy   (after: npm run test:setup)
 *
 * DRAFT→ACTIVE→RETIRED lifecycle, authorized activation + rationale, immutable
 * definitions, one-ACTIVE-at-a-time (incl. concurrent activation), fail-closed
 * safety ops without an approved policy, historical-risk preservation, and the
 * readiness/policy-state surface. Restores v1 ACTIVE at the end so later suites
 * stay deterministic.
 *
 * Fixtures: users +99899000980x, "TEST RP ..." names, TRP* plates.
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

const USERS = { admin: '+998990009801', usta: '+998990009802', sifat: '+998990009803' };
const PASSWORD = 'Sinov-parol-123';

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

let adminId = 0;
const V1_DEF = { algorithm: 'severity_x_likelihood', allowedSeverity: [1, 2, 3, 4], allowedLikelihood: [1, 2, 3, 4], thresholds: [{ min: 12, level: 'CRITICAL' }, { min: 8, level: 'HIGH' }, { min: 4, level: 'MEDIUM' }, { min: 0, level: 'LOW' }], blockingLevels: ['CRITICAL'], sourceOverrides: { STOP_REJECTED: 'CRITICAL' }, severity4MinLevel: 'HIGH' };

/** Reset matrix table to a known state: only v1, and set its status. */
async function setMatrix(status: 'DRAFT' | 'ACTIVE'): Promise<void> {
  await db('risk_matrix_versions').whereNot({ version: 'v1' }).del();
  const v1 = await db('risk_matrix_versions').where({ version: 'v1' }).first();
  if (!v1) await db('risk_matrix_versions').insert({ version: 'v1', definition: JSON.stringify(V1_DEF), status: 'DRAFT' });
  if (status === 'ACTIVE') {
    await db('risk_matrix_versions').where({ version: 'v1' }).update({ status: 'ACTIVE', approved_by: adminId, approved_at: db.raw('CURRENT_TIMESTAMP(6)'), rationale: 'test' });
  } else {
    await db('risk_matrix_versions').where({ version: 'v1' }).update({ status: 'DRAFT', approved_by: null, approved_at: null, rationale: null });
  }
}

async function cleanup(): Promise<void> {
  const jobIds = (await db('jobs').join('vehicles', 'vehicles.id', 'jobs.vehicle_id').where('vehicles.plate_number', 'like', 'TRP%').select('jobs.id')).map((j: { id: number }) => j.id);
  if (jobIds.length > 0) {
    await db('risk_events').whereIn('job_id', jobIds).del();
    await db('completion_snapshots').whereIn('job_id', jobIds).del();
    await db('job_assignments').whereIn('job_id', jobIds).del();
    await db('job_photos').whereIn('job_id', jobIds).del();
    const clIds = (await db('job_checklists').whereIn('job_id', jobIds).select('id')).map((c: { id: number }) => c.id);
    if (clIds.length > 0) { const sIds = (await db('job_steps').whereIn('job_checklist_id', clIds).select('id')).map((s: { id: number }) => s.id); if (sIds.length > 0) await db('job_steps').whereIn('id', sIds).del(); await db('job_checklists').whereIn('id', clIds).del(); }
    await db('audit_logs').whereIn('entity_type', ['job']).whereIn('entity_id', jobIds.map(String)).del();
    await db('jobs').whereIn('id', jobIds).del();
  }
  await db('vehicles').where('plate_number', 'like', 'TRP%').del();
  await db('customers').where('name', 'like', 'TEST RP%').del();
  const users = await db('users').whereIn('phone', Object.values(USERS)).select('id');
  const uids = users.map((u: { id: number }) => u.id);
  if (uids.length > 0) { await db('audit_logs').whereIn('user_id', uids).del(); await db('sessions').whereIn('user_id', uids).del(); }
  await db('users').whereIn('phone', Object.values(USERS)).del();
  await db('branches').where('name', 'like', 'TEST RP%').del();
}

async function run(): Promise<void> {
  setSmsProviderForTesting({ name: 'test-capture', send: async () => ({ providerMessageId: null, outcome: 'ACCEPTED' as const }) });
  setStorageProviderForTesting(new MemoryStorageProvider());
  await assertTestDatabase(db);
  await cleanup();

  const roles = await db('roles').select('id', 'code');
  const roleId = (c: string) => roles.find((r: { code: string }) => r.code === c)?.id;
  const [branchA] = await db('branches').insert({ name: 'TEST RP Branch', region: 'Toshkent shahri', status: 'ACTIVE' });
  const pw = await bcrypt.hash(PASSWORD, 10);
  const b = { password_hash: pw, region: 'Toshkent shahri', status: 'ACTIVE' };
  const ins = async (r: Record<string, unknown>) => (await db('users').insert(r))[0] as number;
  adminId = await ins({ ...b, first_name: 'Rp', last_name: 'Admin', phone: USERS.admin, branch_id: null, role_id: roleId('ADMIN') });
  await ins({ ...b, first_name: 'Rp', last_name: 'Usta', phone: USERS.usta, branch_id: branchA, role_id: roleId('USTA') });
  await ins({ ...b, first_name: 'Rp', last_name: 'Sifat', phone: USERS.sifat, branch_id: null, role_id: roleId('SIFAT') });

  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  console.log(`\nRunning risk-policy E2E against ${baseUrl}\n`);

  const usta = await login(USERS.usta);
  const sifat = await login(USERS.sifat);
  const admin = await login(USERS.admin);

  const c = await http('POST', '/api/v1/customers', { cookie: usta, body: { name: 'TEST RP Mijoz', phone: '99 000 98 11' } });
  const customerId = c.body.customer.id as number;
  let plate = 0;
  const mkDraftJob = async () => {
    const p = `TRP${String(++plate).padStart(3, '0')}`;
    const v = await http('POST', '/api/v1/vehicles', { cookie: usta, body: { customerId, plateNumber: p, make: 'Chevrolet', model: 'Spark' } });
    const j = await http('POST', '/api/v1/jobs', { cookie: usta, body: { customerId, vehicleId: v.body.vehicle.id } });
    return j.body.job.id as number;
  };

  // ---- fail closed without an approved policy ----
  await test('no ACTIVE policy → job start and risk creation fail closed (RISK_POLICY_NOT_APPROVED)', async () => {
    await setMatrix('ACTIVE');
    const jobId = await mkDraftJob();
    assert.equal((await http('POST', `/api/v1/jobs/${jobId}/start`, { cookie: usta })).status, 200); // started while active
    await setMatrix('DRAFT'); // now no ACTIVE policy (DRAFT cannot govern)
    const rk = await http('POST', `/api/v1/jobs/${jobId}/risks`, { cookie: usta, body: { hazard: 'Gaz', description: 'sizish', severity: 4, likelihood: 4 } });
    assert.equal(rk.status, 409);
    assert.equal(rk.body.error.code, 'RISK_POLICY_NOT_APPROVED');
    const draft2 = await mkDraftJob();
    const start2 = await http('POST', `/api/v1/jobs/${draft2}/start`, { cookie: usta });
    assert.equal(start2.status, 409);
    assert.equal(start2.body.error.code, 'RISK_POLICY_NOT_APPROVED');
  });

  // ---- unauthorized activation ----
  await test('a USTA cannot activate a risk matrix (403)', async () => {
    await setMatrix('DRAFT');
    assert.equal((await http('POST', '/api/v1/risk-policy/v1/activate', { cookie: usta, body: { rationale: 'x try' } })).status, 403);
  });

  // ---- activation requires rationale ----
  await test('activation requires a rationale', async () => {
    await setMatrix('DRAFT');
    assert.equal((await http('POST', '/api/v1/risk-policy/v1/activate', { cookie: sifat, body: {} })).status, 422);
  });

  // ---- authorized activation + policy state ----
  await test('an authorized SIFAT activates v1 with rationale; policy state exposed', async () => {
    await setMatrix('DRAFT');
    const act = await http('POST', '/api/v1/risk-policy/v1/activate', { cookie: sifat, body: { rationale: 'Approved by safety specialist ref#42' } });
    assert.equal(act.status, 200, JSON.stringify(act.body));
    const state = await http('GET', '/api/v1/risk-policy', { cookie: usta });
    assert.equal(state.body.active, true);
    assert.equal(state.body.version, 'v1');
    const row = await db('risk_matrix_versions').where({ version: 'v1' }).first();
    assert.equal(row.status, 'ACTIVE');
    assert.ok(row.approved_by && row.approved_at && row.rationale);
    assert.ok(await db('audit_logs').where({ action: 'RISK_MATRIX_ACTIVATED' }).first());
  });

  // ---- immutable version + new version doesn't alter historical risks ----
  await test('new version does not alter historical risks; a version cannot be recreated', async () => {
    await setMatrix('ACTIVE');
    const jobId = await mkDraftJob();
    assert.equal((await http('POST', `/api/v1/jobs/${jobId}/start`, { cookie: usta })).status, 200);
    const rk = await http('POST', `/api/v1/jobs/${jobId}/risks`, { cookie: usta, body: { hazard: 'Gaz', description: 'past risk', severity: 2, likelihood: 2 } });
    assert.equal(rk.status, 201, JSON.stringify(rk.body));
    const before = await db('risk_events').where({ id: rk.body.risk.id }).first();
    assert.equal(before.matrix_version, 'v1');
    assert.equal(before.level, 'MEDIUM'); // 2×2=4 → MEDIUM under v1

    // Create + activate v2 with DIFFERENT thresholds (everything CRITICAL).
    const v2 = { ...V1_DEF, thresholds: [{ min: 0, level: 'CRITICAL' }] };
    assert.equal((await http('POST', '/api/v1/risk-policy/versions', { cookie: sifat, body: { version: 'v2', definition: v2 } })).status, 201);
    // Cannot recreate v2 (immutable identity).
    assert.equal((await http('POST', '/api/v1/risk-policy/versions', { cookie: sifat, body: { version: 'v2', definition: v2 } })).body.error.code, 'VERSION_EXISTS');
    assert.equal((await http('POST', '/api/v1/risk-policy/v2/activate', { cookie: sifat, body: { rationale: 'switch to v2' } })).status, 200);

    // Historical risk unchanged; exactly one ACTIVE.
    const after = await db('risk_events').where({ id: rk.body.risk.id }).first();
    assert.equal(after.matrix_version, 'v1');
    assert.equal(after.level, 'MEDIUM');
    assert.equal((await db('risk_matrix_versions').where({ status: 'ACTIVE' })).length, 1);
    assert.equal((await db('risk_matrix_versions').where({ version: 'v1' }).first()).status, 'RETIRED');

    // A NEW risk is scored under the now-active v2 (2×2 → CRITICAL) + stores v2.
    const rk2 = await http('POST', `/api/v1/jobs/${jobId}/risks`, { cookie: usta, body: { hazard: 'Gaz', description: 'new risk', severity: 2, likelihood: 2 } });
    const row2 = await db('risk_events').where({ id: rk2.body.risk.id }).first();
    assert.equal(row2.matrix_version, 'v2');
    assert.equal(row2.level, 'CRITICAL');
  });

  // ---- concurrency: exactly one ACTIVE after every race, no crash/deadlock ----
  // Fixtures use UNIQUE version identifiers per case so no state can leak between
  // tests or runs. Races target DRAFT versions (activating a DRAFT is always a
  // valid transition) so the outcome is deterministic: both succeed and exactly
  // one ends ACTIVE — regardless of which transaction the singleton lock admits
  // first. (Re-activating a version another racer just RETIRED is a correct 409,
  // MATRIX_RETIRED — never weakened; that scenario is asserted explicitly below.)
  let vseq = 0;
  const uniqueVersion = (tag: string) => `rc-${Date.now().toString(36)}-${tag}-${++vseq}`;
  const mkVersion = async (v: string, def: unknown = V1_DEF) =>
    http('POST', '/api/v1/risk-policy/versions', { cookie: sifat, body: { version: v, definition: def } });
  const activeVersions = async (): Promise<string[]> =>
    (await db('risk_matrix_versions').where({ status: 'ACTIVE' }).select('version')).map((r: { version: string }) => r.version);

  await test('concurrent activation of two DRAFT versions (no current ACTIVE) leaves exactly one ACTIVE', async () => {
    await setMatrix('DRAFT'); // no ACTIVE matrix
    const va = uniqueVersion('a'), vb = uniqueVersion('b');
    assert.equal((await mkVersion(va)).status, 201);
    assert.equal((await mkVersion(vb)).status, 201);
    const [a, bb] = await Promise.all([
      http('POST', `/api/v1/risk-policy/${va}/activate`, { cookie: sifat, body: { rationale: 'race a' } }),
      http('POST', `/api/v1/risk-policy/${vb}/activate`, { cookie: admin, body: { rationale: 'race b' } }),
    ]);
    // Activating a DRAFT is always valid — both succeed regardless of order.
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(bb.status, 200, JSON.stringify(bb.body));
    const active = await activeVersions();
    assert.equal(active.length, 1, `exactly one ACTIVE, got ${JSON.stringify(active)}`);
    assert.ok(active[0] === va || active[0] === vb);
  });

  await test('concurrent activation of two DRAFT versions while another is ACTIVE leaves exactly one ACTIVE (prior retired)', async () => {
    await setMatrix('ACTIVE'); // v1 ACTIVE
    const va = uniqueVersion('a'), vb = uniqueVersion('b');
    await mkVersion(va);
    await mkVersion(vb);
    const [a, bb] = await Promise.all([
      http('POST', `/api/v1/risk-policy/${va}/activate`, { cookie: sifat, body: { rationale: 'race a' } }),
      http('POST', `/api/v1/risk-policy/${vb}/activate`, { cookie: admin, body: { rationale: 'race b' } }),
    ]);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(bb.status, 200, JSON.stringify(bb.body));
    const active = await activeVersions();
    assert.equal(active.length, 1, `exactly one ACTIVE, got ${JSON.stringify(active)}`);
    assert.ok(active[0] === va || active[0] === vb);
    assert.equal((await db('risk_matrix_versions').where({ version: 'v1' }).first()).status, 'RETIRED');
  });

  await test('re-activating a version a concurrent activation just RETIRED is a clean 409 (invariant preserved)', async () => {
    // v1 ACTIVE + one DRAFT challenger. Racing activate(v1) vs activate(challenger)
    // can retire v1 first; re-activating a RETIRED matrix must be a deterministic
    // 409 MATRIX_RETIRED (never a 500/deadlock, never two ACTIVE, never weakened).
    await setMatrix('ACTIVE');
    const vb = uniqueVersion('chal');
    await mkVersion(vb);
    const [a, bb] = await Promise.all([
      http('POST', '/api/v1/risk-policy/v1/activate', { cookie: sifat, body: { rationale: 'keep v1' } }),
      http('POST', `/api/v1/risk-policy/${vb}/activate`, { cookie: admin, body: { rationale: 'switch' } }),
    ]);
    for (const r of [a, bb]) {
      assert.ok(r.status === 200 || (r.status === 409 && r.body?.error?.code === 'MATRIX_RETIRED'), `unexpected ${r.status} ${JSON.stringify(r.body)}`);
    }
    assert.ok(a.status === 200 || bb.status === 200, 'at least one activation succeeds');
    const active = await activeVersions();
    assert.equal(active.length, 1, `exactly one ACTIVE, got ${JSON.stringify(active)}`);
  });

  await test('activate vs retire race leaves exactly one ACTIVE (no deadlock)', async () => {
    await setMatrix('ACTIVE'); // v1 ACTIVE
    const vb = uniqueVersion('b');
    await mkVersion(vb);
    const [act, ret] = await Promise.all([
      http('POST', `/api/v1/risk-policy/${vb}/activate`, { cookie: sifat, body: { rationale: 'activate b' } }),
      http('POST', '/api/v1/risk-policy/v1/retire', { cookie: admin }),
    ]);
    assert.equal(act.status, 200, JSON.stringify(act.body));
    assert.equal(ret.status, 200, JSON.stringify(ret.body));
    const active = await activeVersions();
    assert.equal(active.length, 1, `exactly one ACTIVE (the activated version), got ${JSON.stringify(active)}`);
    assert.equal(active[0], vb);
  });

  await test('activate vs risk creation race: no deadlock, risk scored under a valid matrix, exactly one ACTIVE', async () => {
    await setMatrix('ACTIVE'); // v1 ACTIVE (2×2 → MEDIUM)
    const jobId = await mkDraftJob();
    assert.equal((await http('POST', `/api/v1/jobs/${jobId}/start`, { cookie: usta })).status, 200);
    const vb = uniqueVersion('b');
    await mkVersion(vb, { ...V1_DEF, thresholds: [{ min: 0, level: 'CRITICAL' }] }); // everything CRITICAL
    const [act, rk] = await Promise.all([
      http('POST', `/api/v1/risk-policy/${vb}/activate`, { cookie: sifat, body: { rationale: 'switch mid-risk' } }),
      http('POST', `/api/v1/jobs/${jobId}/risks`, { cookie: usta, body: { hazard: 'Gaz', description: 'race', severity: 2, likelihood: 2 } }),
    ]);
    assert.equal(act.status, 200, JSON.stringify(act.body));
    assert.equal(rk.status, 201, JSON.stringify(rk.body)); // risk creation never deadlocks with activation
    const row = await db('risk_events').where({ id: rk.body.risk.id }).first();
    // Scored under whichever matrix the read saw — both are valid, immutable choices.
    assert.ok(row.matrix_version === 'v1' || row.matrix_version === vb, `matrix ${row.matrix_version}`);
    const active = await activeVersions();
    assert.equal(active.length, 1, `exactly one ACTIVE, got ${JSON.stringify(active)}`);
    assert.equal(active[0], vb);
  });

  await test('failed activations do not leak DB connections/transactions', async () => {
    await setMatrix('ACTIVE');
    // Retire a version, then hammer activation of the RETIRED version (all 409).
    const vb = uniqueVersion('leak');
    await mkVersion(vb);
    await http('POST', `/api/v1/risk-policy/${vb}/retire`, { cookie: sifat }); // ensure RETIRED
    const pool = (db.client as unknown as { pool: { numUsed(): number; numFree(): number; numPendingAcquires(): number; numPendingCreates(): number } }).pool;
    const before = pool.numUsed();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => http('POST', `/api/v1/risk-policy/${vb}/activate`, { cookie: sifat, body: { rationale: 'retry retired' } })),
    );
    assert.ok(results.every((r) => r.status === 409 && r.body?.error?.code === 'MATRIX_RETIRED'), 'every activation of a RETIRED matrix is a clean 409');
    // Let the pool settle, then confirm nothing is stuck acquiring/holding.
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(pool.numPendingAcquires(), 0, 'no pending acquires after failures');
    assert.ok(pool.numUsed() <= before + 1, `connections returned to the pool (before=${before}, after=${pool.numUsed()})`);
    assert.equal((await activeVersions()).length, 1, 'still exactly one ACTIVE after the failure burst');
  });

  // ---- retirement without replacement fails safely ----
  await test('retiring the active matrix leaves the domain fail-closed (safe)', async () => {
    await setMatrix('ACTIVE');
    assert.equal((await http('POST', '/api/v1/risk-policy/v1/retire', { cookie: sifat })).status, 200);
    assert.equal((await http('GET', '/api/v1/risk-policy', { cookie: usta })).body.active, false);
    const ready = await http('GET', '/api/v1/ready');
    assert.equal(ready.body.checks.riskPolicy, false);
    assert.notEqual(ready.status, 200, 'readiness is not 200 without an approved policy');
    // A new job cannot start.
    const jobId = await mkDraftJob();
    assert.equal((await http('POST', `/api/v1/jobs/${jobId}/start`, { cookie: usta })).body.error.code, 'RISK_POLICY_NOT_APPROVED');
  });

  // Restore v1 ACTIVE for subsequent suites.
  await setMatrix('ACTIVE');
  await cleanup();
  server.close();
  await db.destroy();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

run().catch(async (err) => { console.error(err); try { await setMatrix('ACTIVE'); } catch { /* ignore */ } try { await db.destroy(); } catch { /* ignore */ } process.exit(1); });
