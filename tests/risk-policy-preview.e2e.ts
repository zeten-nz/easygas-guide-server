/**
 * EASY GAS — Phase 11C risk-policy DISPLAY + illustrative PREVIEW (read-only).
 *
 *   npm run test:riskpolicy-preview   (after: npm run test:setup)
 *
 * Verifies: the version-detail definition matches the stored row and its
 * server-computed grid matches the SHARED evaluator; the preview agrees with the
 * evaluator at threshold boundaries and honours source overrides; the preview
 * writes NO risk/policy mutation; a DRAFT preview never makes a DRAFT usable for a
 * real assessment (production assessRisk still fails closed without an ACTIVE
 * policy); unauthorized callers are refused; out-of-range inputs are rejected;
 * and the approver name resolves in the detail. Restores v1 ACTIVE at the end.
 *
 * Fixtures: users +99899000970x, "TEST RPP ..." names, TRPP* plates.
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
import { classify, V1_DEFINITION, type MatrixDefinition } from '../src/modules/risk/risk-policy.service';

const USERS = { admin: '+998990009701', usta: '+998990009702', sifat: '+998990009703' };
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

async function setMatrix(status: 'DRAFT' | 'ACTIVE'): Promise<void> {
  await db('risk_matrix_versions').whereNot({ version: 'v1' }).del();
  const v1 = await db('risk_matrix_versions').where({ version: 'v1' }).first();
  if (!v1) await db('risk_matrix_versions').insert({ version: 'v1', definition: JSON.stringify(V1_DEFINITION), status: 'DRAFT' });
  if (status === 'ACTIVE') await db('risk_matrix_versions').where({ version: 'v1' }).update({ status: 'ACTIVE', approved_by: adminId, approved_at: db.raw('CURRENT_TIMESTAMP(6)'), rationale: 'test bootstrap' });
  else await db('risk_matrix_versions').where({ version: 'v1' }).update({ status: 'DRAFT', approved_by: null, approved_at: null, rationale: null });
}

async function cleanup(): Promise<void> {
  const jobIds = (await db('jobs').join('vehicles', 'vehicles.id', 'jobs.vehicle_id').where('vehicles.plate_number', 'like', 'TRPP%').select('jobs.id')).map((j: { id: number }) => j.id);
  if (jobIds.length > 0) {
    await db('risk_events').whereIn('job_id', jobIds).del();
    await db('job_assignments').whereIn('job_id', jobIds).del();
    await db('audit_logs').whereIn('entity_type', ['job']).whereIn('entity_id', jobIds.map(String)).del();
    await db('jobs').whereIn('id', jobIds).del();
  }
  await db('vehicles').where('plate_number', 'like', 'TRPP%').del();
  await db('customers').where('name', 'like', 'TEST RPP%').del();
  const users = await db('users').whereIn('phone', Object.values(USERS)).select('id');
  const uids = users.map((u: { id: number }) => u.id);
  if (uids.length > 0) { await db('audit_logs').whereIn('user_id', uids).del(); await db('sessions').whereIn('user_id', uids).del(); }
  await db('users').whereIn('phone', Object.values(USERS)).del();
  await db('risk_matrix_versions').where('version', 'like', 'rpp-%').del();
}

async function run(): Promise<void> {
  setSmsProviderForTesting({ name: 'test-capture', send: async () => ({ providerMessageId: null, outcome: 'ACCEPTED' as const }) });
  setStorageProviderForTesting(new MemoryStorageProvider());
  await assertTestDatabase(db);
  await cleanup();

  const roles = await db('roles').select('id', 'code');
  const roleId = (c: string) => roles.find((r: { code: string }) => r.code === c)?.id;
  const pw = await bcrypt.hash(PASSWORD, 10);
  const b = { password_hash: pw, region: 'Toshkent shahri', status: 'ACTIVE' };
  const ins = async (r: Record<string, unknown>) => (await db('users').insert(r))[0] as number;
  adminId = await ins({ ...b, first_name: 'Rpp', last_name: 'Admin', phone: USERS.admin, branch_id: null, role_id: roleId('ADMIN') });
  const [branchA] = await db('branches').insert({ name: 'TEST RPP Branch', region: 'Toshkent shahri', status: 'ACTIVE' });
  await ins({ ...b, first_name: 'Rpp', last_name: 'Usta', phone: USERS.usta, branch_id: branchA, role_id: roleId('USTA') });
  await ins({ ...b, first_name: 'Rpp', last_name: 'Sifat', phone: USERS.sifat, branch_id: null, role_id: roleId('SIFAT') });

  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  console.log(`\nRunning risk-policy-preview E2E against ${baseUrl}\n`);

  const usta = await login(USERS.usta);
  const sifat = await login(USERS.sifat);
  const admin = await login(USERS.admin);

  await test('version detail: definition matches stored row + grid matches the shared evaluator', async () => {
    await setMatrix('ACTIVE');
    const r = await http('GET', '/api/v1/risk-policy/versions/v1', { cookie: sifat });
    assert.equal(r.status, 200);
    const v = r.body.version;
    assert.deepEqual(v.definition, V1_DEFINITION);
    assert.equal(v.status, 'ACTIVE');
    assert.equal(v.isActive, true);
    // Every cell equals the shared classify() (source=MANUAL).
    assert.equal(v.cells.length, V1_DEFINITION.allowedSeverity.length * V1_DEFINITION.allowedLikelihood.length);
    for (const cell of v.cells) {
      const expected = classify(V1_DEFINITION as MatrixDefinition, cell.severity, cell.likelihood, 'MANUAL');
      assert.equal(cell.score, expected.score, `score ${cell.severity}x${cell.likelihood}`);
      assert.equal(cell.level, expected.level, `level ${cell.severity}x${cell.likelihood}`);
      assert.equal(cell.blocking, expected.blocking, `blocking ${cell.severity}x${cell.likelihood}`);
    }
    // Blocking-level risks affect completion + quality.
    assert.ok(Array.isArray(v.blockedOperations) && v.blockedOperations.length === 2);
  });

  await test('version detail resolves the approver display name', async () => {
    await setMatrix('ACTIVE'); // approved_by = adminId
    const r = await http('GET', '/api/v1/risk-policy/versions/v1', { cookie: admin });
    assert.equal(r.body.version.approvedBy, adminId);
    assert.equal(r.body.version.approvedByName, 'Rpp Admin');
  });

  await test('preview agrees with the evaluator at threshold boundaries', async () => {
    const cases: Array<[number, number, string, number, string, boolean]> = [
      // severity, likelihood, source, expScore, expLevel, expBlocking
      [1, 1, 'MANUAL', 1, 'LOW', false],
      [2, 2, 'MANUAL', 4, 'MEDIUM', false], // score 4 → MEDIUM boundary
      [2, 4, 'MANUAL', 8, 'HIGH', false], // score 8 → HIGH boundary
      [3, 4, 'MANUAL', 12, 'CRITICAL', true], // score 12 → CRITICAL boundary (blocking)
      [4, 1, 'MANUAL', 4, 'HIGH', false], // severity4MinLevel raises MEDIUM→HIGH
      [1, 1, 'STOP_REJECTED', 1, 'CRITICAL', true], // source override forces CRITICAL
    ];
    for (const [s, l, src, score, level, blocking] of cases) {
      const r = await http('GET', `/api/v1/risk-policy/versions/v1/preview?severity=${s}&likelihood=${l}&source=${src}`, { cookie: sifat });
      assert.equal(r.status, 200, `${s}x${l}/${src}`);
      assert.equal(r.body.preview.score, score, `score ${s}x${l}/${src}`);
      assert.equal(r.body.preview.level, level, `level ${s}x${l}/${src}`);
      assert.equal(r.body.preview.blocking, blocking, `blocking ${s}x${l}/${src}`);
      assert.equal(r.body.preview.example, true);
      // Cross-check with the shared evaluator directly.
      const expect = classify(V1_DEFINITION as MatrixDefinition, s, l, src as any);
      assert.equal(r.body.preview.level, expect.level);
    }
  });

  await test('preview writes NO risk event and NO policy mutation', async () => {
    const risksBefore = Number((await db('risk_events').count({ c: '*' }))[0].c);
    const versionsBefore = await db('risk_matrix_versions').orderBy('id').select('id', 'status', 'definition', 'approved_by');
    await http('GET', '/api/v1/risk-policy/versions/v1/preview?severity=4&likelihood=4&source=MANUAL', { cookie: sifat });
    await http('GET', '/api/v1/risk-policy/versions/v1', { cookie: sifat });
    const risksAfter = Number((await db('risk_events').count({ c: '*' }))[0].c);
    const versionsAfter = await db('risk_matrix_versions').orderBy('id').select('id', 'status', 'definition', 'approved_by');
    assert.equal(risksAfter, risksBefore, 'no risk event created');
    assert.deepEqual(versionsAfter, versionsBefore, 'no policy row changed');
  });

  await test('a DRAFT preview does NOT make a DRAFT usable for a real assessment (assessRisk still fails closed)', async () => {
    // Create a DRAFT candidate version and preview it — allowed, read-only.
    const create = await http('POST', '/api/v1/risk-policy/versions', { cookie: admin, body: { version: 'rpp-draft', definition: V1_DEFINITION } });
    assert.equal(create.status, 201);
    const prev = await http('GET', '/api/v1/risk-policy/versions/rpp-draft/preview?severity=3&likelihood=4', { cookie: admin });
    assert.equal(prev.status, 200);
    assert.equal(prev.body.preview.level, 'CRITICAL');
    assert.equal(prev.body.preview.status, 'DRAFT');
    // Now make the domain fail-closed (no ACTIVE policy) and confirm a real
    // operation is still refused — the DRAFT preview changed nothing.
    await setMatrix('DRAFT'); // v1 back to DRAFT → no ACTIVE at all
    await db('risk_matrix_versions').where({ version: 'rpp-draft' }).update({ status: 'DRAFT' });
    const c = await http('POST', '/api/v1/customers', { cookie: usta, body: { name: 'TEST RPP Mijoz', phone: '99 000 97 11' } });
    const v = await http('POST', '/api/v1/vehicles', { cookie: usta, body: { customerId: c.body.customer.id, plateNumber: 'TRPP001', make: 'Chevrolet', model: 'Spark' } });
    const j = await http('POST', '/api/v1/jobs', { cookie: usta, body: { customerId: c.body.customer.id, vehicleId: v.body.vehicle.id } });
    const start = await http('POST', `/api/v1/jobs/${j.body.job.id}/start`, { cookie: usta });
    assert.equal(start.status, 409);
    assert.equal(start.body.error.code, 'RISK_POLICY_NOT_APPROVED');
  });

  await test('unauthorized (USTA) cannot read version detail or preview (403)', async () => {
    assert.equal((await http('GET', '/api/v1/risk-policy/versions/v1', { cookie: usta })).status, 403);
    assert.equal((await http('GET', '/api/v1/risk-policy/versions/v1/preview?severity=1&likelihood=1', { cookie: usta })).status, 403);
  });

  await test('out-of-range severity/likelihood and unknown version are rejected', async () => {
    const over = await http('GET', '/api/v1/risk-policy/versions/v1/preview?severity=9&likelihood=1', { cookie: sifat });
    assert.equal(over.status, 422);
    assert.equal(over.body.error.code, 'INVALID_SEVERITY');
    assert.equal((await http('GET', '/api/v1/risk-policy/versions/nope', { cookie: sifat })).status, 404);
  });

  // Restore v1 ACTIVE for downstream suite determinism.
  await db('risk_matrix_versions').where('version', 'like', 'rpp-%').del();
  await setMatrix('ACTIVE');
  await cleanup();

  server.close();
  console.log(`\nrisk-policy-preview: ${passed} passed, ${failed} failed\n`);
  await db.destroy();
  if (failed > 0) process.exit(1);
}

run().catch((err) => { console.error(err); process.exit(1); });
