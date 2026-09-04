/**
 * EASY GAS — Phase 10A security & concurrency hardening E2E tests.
 *
 * Covers: CSRF matrix (A), trust-proxy IP handling (B), OTP verification
 * races (C), reset-token single-use races (D), last-active-admin invariant
 * races (E), checklist assignment races (F), inactive-branch enforcement (G),
 * test-DB guard behavior (H), MySQL error mapping (I).
 *
 *   npm run test:hardening   (after: npm run test:setup)
 *
 * Fixtures: users +99899000880x, "TEST HD ..." names, THD* plates.
 */
import { assertTestDatabase } from './helpers/test-env'; // MUST be first: NODE_ENV=test + *_test DB
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import { db } from '../src/config/database';
import { createApp } from '../src/app';
import { csrfTokenFor } from '../src/middleware/csrf.middleware';
import { errorHandler } from '../src/middleware/error.middleware';
import { env } from '../src/config/env';
import { setSmsProviderForTesting } from '../src/sms';

const USERS = {
  adminX: '+998990008801',
  adminY: '+998990008802',
  ustaH: '+998990008803',
  sifat: '+998990008804',
  ustaMain: '+998990008805',
  otpUser1: '+998990008806',
  otpUser2: '+998990008807',
  resetUser: '+998990008808',
};

const PASSWORD = 'Sinov-parol-123';

let baseUrl = '';

interface HttpResult {
  status: number;
  body: any;
  setCookies: string[];
}

/** Raw request — sends EXACTLY the given headers (no automatic CSRF token). */
async function rawHttp(
  method: string,
  pathname: string,
  opts: { body?: unknown; headers?: Record<string, string>; base?: string } = {},
): Promise<HttpResult> {
  const res = await fetch(`${opts.base ?? baseUrl}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
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

/** Standard client behavior: cookie + matching session-bound CSRF token. */
async function http(method: string, pathname: string, opts: { body?: unknown; cookie?: string } = {}): Promise<HttpResult> {
  return rawHttp(method, pathname, {
    body: opts.body,
    headers: opts.cookie ? { cookie: opts.cookie, 'x-csrf-token': csrfTokenFor(opts.cookie.split('=')[1] ?? '') } : {},
  });
}

async function login(phone: string, base?: string, headers?: Record<string, string>): Promise<{ cookie: string; csrfToken: string }> {
  const res = await rawHttp('POST', '/api/v1/auth/login', {
    body: { phone, password: PASSWORD, rememberMe: false },
    headers,
    base,
  });
  assert.equal(res.status, 200, `login failed for ${phone}: ${JSON.stringify(res.body)}`);
  const raw = res.setCookies.find((c) => c.startsWith('eg_session='));
  assert.ok(raw);
  return { cookie: raw.split(';')[0], csrfToken: res.body.csrfToken };
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
// Fixtures
// ---------------------------------------------------------------------------

async function cleanup(): Promise<void> {
  const jobIds = (
    await db('jobs')
      .join('vehicles', 'vehicles.id', 'jobs.vehicle_id')
      .where('vehicles.plate_number', 'like', 'THD%')
      .select('jobs.id')
  ).map((j: { id: number }) => j.id);
  if (jobIds.length > 0) {
    const checklistIds = (await db('job_checklists').whereIn('job_id', jobIds).select('id')).map((c: { id: number }) => c.id);
    if (checklistIds.length > 0) {
      const stepIds = (await db('job_steps').whereIn('job_checklist_id', checklistIds).select('id')).map(
        (s: { id: number }) => s.id,
      );
      if (stepIds.length > 0) {
        await db('step_measurements').whereIn('job_step_id', stepIds).del();
        await db('audit_logs').where('entity_type', 'job_step').whereIn('entity_id', stepIds.map(String)).del();
        await db('job_steps').whereIn('id', stepIds).del();
      }
      await db('job_checklists').whereIn('id', checklistIds).del();
    }
    await db('audit_logs').where('entity_type', 'job').whereIn('entity_id', jobIds.map(String)).del();
    await db('jobs').whereIn('id', jobIds).del();
  }

  const templateIds = (await db('checklist_templates').where('name', 'like', 'TEST HD%').select('id')).map(
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

  const customerIds = (await db('customers').where('name', 'like', 'TEST HD%').select('id')).map(
    (c: { id: number }) => c.id,
  );
  await db('vehicles').where('plate_number', 'like', 'THD%').del();
  if (customerIds.length > 0) {
    await db('audit_logs').where('entity_type', 'customer').whereIn('entity_id', customerIds.map(String)).del();
    await db('customers').whereIn('id', customerIds).del();
  }

  const users = await db('users').whereIn('phone', Object.values(USERS)).select('id');
  const userIds = users.map((u: { id: number }) => u.id);
  if (userIds.length > 0) {
    await db('audit_logs').whereIn('user_id', userIds).del();
    await db('sessions').whereIn('user_id', userIds).del();
    await db('password_resets').whereIn('user_id', userIds).del();
  }
  await db('users').whereIn('phone', Object.values(USERS)).del();
  const branchIds = (await db('branches').where('name', 'like', 'TEST HD%').select('id')).map((b: { id: number }) =>
    String(b.id),
  );
  if (branchIds.length > 0) {
    await db('audit_logs').where('entity_type', 'branch').whereIn('entity_id', branchIds).del();
  }
  await db('branches').where('name', 'like', 'TEST HD%').del();
}

async function createFixtures() {
  const roles = await db('roles').select('id', 'code');
  const roleId = (code: string) => roles.find((r: { code: string }) => r.code === code)?.id;
  const [branchA] = await db('branches').insert({ name: 'TEST HD Branch A', region: 'Toshkent shahri', status: 'ACTIVE' });
  const [branchH] = await db('branches').insert({ name: 'TEST HD Branch H', region: 'Samarqand', status: 'ACTIVE' });

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const base = { password_hash: passwordHash, region: 'Toshkent shahri', status: 'ACTIVE' };
  const insert = async (row: Record<string, unknown>) => {
    const [id] = await db('users').insert(row);
    return id as number;
  };

  const ids: Record<string, number> = {};
  ids.adminX = await insert({ ...base, first_name: 'Hd', last_name: 'AdminX', phone: USERS.adminX, branch_id: null, role_id: roleId('ADMIN') });
  ids.adminY = await insert({ ...base, first_name: 'Hd', last_name: 'AdminY', phone: USERS.adminY, branch_id: null, role_id: roleId('ADMIN') });
  ids.ustaH = await insert({ ...base, first_name: 'Hd', last_name: 'UstaH', phone: USERS.ustaH, branch_id: branchH, role_id: roleId('USTA') });
  ids.sifat = await insert({ ...base, first_name: 'Hd', last_name: 'Sifat', phone: USERS.sifat, branch_id: null, role_id: roleId('SIFAT') });
  ids.ustaMain = await insert({ ...base, first_name: 'Hd', last_name: 'UstaMain', phone: USERS.ustaMain, branch_id: branchA, role_id: roleId('USTA') });
  ids.otpUser1 = await insert({ ...base, first_name: 'Hd', last_name: 'Otp1', phone: USERS.otpUser1, branch_id: branchA, role_id: roleId('USTA') });
  ids.otpUser2 = await insert({ ...base, first_name: 'Hd', last_name: 'Otp2', phone: USERS.otpUser2, branch_id: branchA, role_id: roleId('USTA') });
  ids.resetUser = await insert({ ...base, first_name: 'Hd', last_name: 'Reset', phone: USERS.resetUser, branch_id: branchA, role_id: roleId('USTA') });

  return { branchA: branchA as number, branchH: branchH as number, ids };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const smsInbox: { phone: string; message: string }[] = [];
  setSmsProviderForTesting({
    name: 'test-capture',
    async send(phone, message) {
      smsInbox.push({ phone, message });
    },
  });
  const lastOtpFor = (phone: string) => {
    const msg = [...smsInbox].reverse().find((m) => m.phone === phone);
    assert.ok(msg, `no SMS captured for ${phone}`);
    return msg.message.match(/\b(\d{6})\b/)![1];
  };

  await assertTestDatabase(db);
  await cleanup();
  const fx = await createFixtures();

  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;

  console.log(`\nRunning hardening E2E against ${baseUrl}\n`);

  const ustaMain = await login(USERS.ustaMain);
  const adminX = await login(USERS.adminX);

  // ------------------------------- A. CSRF -------------------------------

  await test('CSRF: cookie-bearing mutation without token is refused, nothing written', async () => {
    const res = await rawHttp('POST', '/api/v1/customers', {
      headers: { cookie: ustaMain.cookie },
      body: { name: 'TEST HD CSRFsiz', phone: '99 000 88 21' },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'CSRF_TOKEN');
    assert.equal(await db('customers').where({ name: 'TEST HD CSRFsiz' }).first(), undefined);
  });

  await test('CSRF: invalid and cross-session tokens are refused', async () => {
    const wrong = await rawHttp('POST', '/api/v1/customers', {
      headers: { cookie: ustaMain.cookie, 'x-csrf-token': 'f'.repeat(64) },
      body: { name: 'TEST HD Yolgon', phone: '99 000 88 22' },
    });
    assert.equal(wrong.status, 403);
    const crossSession = await rawHttp('POST', '/api/v1/customers', {
      headers: { cookie: ustaMain.cookie, 'x-csrf-token': adminX.csrfToken },
      body: { name: 'TEST HD Yolgon', phone: '99 000 88 22' },
    });
    assert.equal(crossSession.status, 403, 'a token from another session must not validate');
  });

  await test('CSRF: valid token mutates; server-issued token equals the session-bound derivation', async () => {
    assert.equal(ustaMain.csrfToken, csrfTokenFor(ustaMain.cookie.split('=')[1]), 'login must hand out the bound token');
    const me = await rawHttp('GET', '/api/v1/auth/me', { headers: { cookie: ustaMain.cookie } });
    assert.equal(me.body.csrfToken, ustaMain.csrfToken, '/auth/me re-issues the same token');

    const res = await rawHttp('POST', '/api/v1/customers', {
      headers: { cookie: ustaMain.cookie, 'x-csrf-token': ustaMain.csrfToken },
      body: { name: 'TEST HD Mijoz', phone: '99 000 88 23' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });

  await test('CSRF: untrusted Origin is refused even with a valid token; trusted Origin passes', async () => {
    const evil = await rawHttp('POST', '/api/v1/customers', {
      headers: { cookie: ustaMain.cookie, 'x-csrf-token': ustaMain.csrfToken, origin: 'https://evil.example' },
      body: { name: 'TEST HD Evil', phone: '99 000 88 24' },
    });
    assert.equal(evil.status, 403);
    assert.equal(evil.body.error.code, 'CSRF_ORIGIN');
    assert.equal(await db('customers').where({ name: 'TEST HD Evil' }).first(), undefined);

    const good = await rawHttp('POST', '/api/v1/customers', {
      headers: { cookie: ustaMain.cookie, 'x-csrf-token': ustaMain.csrfToken, origin: env.CLIENT_ORIGIN },
      body: { name: 'TEST HD Origin OK', phone: '99 000 88 25' },
    });
    assert.equal(good.status, 201);

    const evilReferer = await rawHttp('POST', '/api/v1/customers', {
      headers: { cookie: ustaMain.cookie, 'x-csrf-token': ustaMain.csrfToken, referer: 'https://evil.example/page' },
      body: { name: 'TEST HD Referer', phone: '99 000 88 26' },
    });
    assert.equal(evilReferer.status, 403, 'untrusted Referer (no Origin) must be refused');
  });

  await test('CSRF: login itself is origin-screened (login-CSRF), token-free public flows keep working', async () => {
    const evilLogin = await rawHttp('POST', '/api/v1/auth/login', {
      headers: { origin: 'https://evil.example' },
      body: { phone: USERS.ustaMain, password: PASSWORD, rememberMe: false },
    });
    assert.equal(evilLogin.status, 403);

    const trusted = await rawHttp('POST', '/api/v1/auth/login', {
      headers: { origin: env.CLIENT_ORIGIN },
      body: { phone: USERS.ustaMain, password: PASSWORD, rememberMe: false },
    });
    assert.equal(trusted.status, 200, 'trusted-origin login works');
    assert.ok(trusted.body.csrfToken, 'login returns the CSRF token');
  });

  await test('CSRF: safe GET needs no token; logout requires and honors the token', async () => {
    const get = await rawHttp('GET', '/api/v1/jobs', { headers: { cookie: ustaMain.cookie } });
    assert.equal(get.status, 200, 'GET must not require a CSRF token');

    const extra = await login(USERS.ustaMain);
    const noToken = await rawHttp('POST', '/api/v1/auth/logout', { headers: { cookie: extra.cookie } });
    assert.equal(noToken.status, 403, 'cookie-bearing logout without token is refused');
    const ok = await rawHttp('POST', '/api/v1/auth/logout', {
      headers: { cookie: extra.cookie, 'x-csrf-token': extra.csrfToken },
    });
    assert.equal(ok.status, 204);
  });

  // --------------------------- B. Trust proxy ----------------------------

  await test('trust proxy: spoofed X-Forwarded-For is NOT trusted under the default configuration', async () => {
    await login(USERS.otpUser1, undefined, { 'x-forwarded-for': '203.0.113.9' });
    const audit = await db('audit_logs')
      .where({ action: 'LOGIN', user_id: fx.ids.otpUser1 })
      .orderBy('id', 'desc')
      .first();
    assert.ok(audit, 'LOGIN audit row exists');
    assert.notEqual(audit.ip, '203.0.113.9', 'spoofed header must not become the audited client IP');
    assert.match(String(audit.ip), /127\.0\.0\.1|::1/, 'audited IP is the socket address');
  });

  await test('trust proxy: with TRUST_PROXY_HOPS=1 the forwarded client IP is used', async () => {
    const proxiedApp = createApp({ trustProxyHops: 1 });
    const proxiedServer = proxiedApp.listen(0);
    await new Promise<void>((resolve) => proxiedServer.once('listening', resolve));
    const addr = proxiedServer.address() as { port: number };
    const proxiedBase = `http://127.0.0.1:${addr.port}`;

    await login(USERS.otpUser2, proxiedBase, { 'x-forwarded-for': '203.0.113.77' });
    const audit = await db('audit_logs')
      .where({ action: 'LOGIN', user_id: fx.ids.otpUser2 })
      .orderBy('id', 'desc')
      .first();
    assert.equal(audit.ip, '203.0.113.77', 'behind one trusted proxy the forwarded IP is audited');
    proxiedServer.close();
  });

  // --------------------------- C. OTP races ------------------------------

  await test('OTP: concurrent wrong attempts cannot exceed the attempt limit', async () => {
    assert.equal((await http('POST', '/api/v1/auth/forgot-password', { body: { phone: USERS.otpUser1 } })).status, 200);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        http('POST', '/api/v1/auth/verify-otp', { body: { phone: USERS.otpUser1, otp: '000001' } }),
      ),
    );
    assert.ok(results.every((r) => r.status !== 200), 'no wrong attempt may succeed');
    const record = await db('password_resets').where({ user_id: fx.ids.otpUser1 }).orderBy('id', 'desc').first();
    assert.equal(
      record.attempts,
      env.OTP_MAX_ATTEMPTS,
      `attempts must be capped at ${env.OTP_MAX_ATTEMPTS} even under concurrency (got ${record.attempts})`,
    );
    const lateCorrect = await http('POST', '/api/v1/auth/verify-otp', {
      body: { phone: USERS.otpUser1, otp: lastOtpFor(USERS.otpUser1) },
    });
    assert.equal(lateCorrect.status, 429, 'the correct code is refused once the limit is reached');
  });

  await test('OTP: a valid code is consumed exactly once under concurrency', async () => {
    assert.equal((await http('POST', '/api/v1/auth/forgot-password', { body: { phone: USERS.otpUser2 } })).status, 200);
    const otp = lastOtpFor(USERS.otpUser2);
    const [a, b] = await Promise.all([
      http('POST', '/api/v1/auth/verify-otp', { body: { phone: USERS.otpUser2, otp } }),
      http('POST', '/api/v1/auth/verify-otp', { body: { phone: USERS.otpUser2, otp } }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.equal(statuses[0], 200, `exactly one verification succeeds (got ${statuses})`);
    assert.notEqual(statuses[1], 200, `the second consumption must fail (got ${statuses})`);
    const winners = [a, b].filter((r) => r.status === 200);
    assert.equal(winners.length, 1);
    assert.ok(winners[0].body.resetToken, 'winner receives the reset token');
    const record = await db('password_resets').where({ user_id: fx.ids.otpUser2 }).orderBy('id', 'desc').first();
    assert.ok(record.consumed_at, 'consumed exactly once');
  });

  // ------------------------ D. Reset-token races --------------------------

  await test('reset token: two simultaneous resets — exactly one succeeds, sessions revoked', async () => {
    const preSession = await login(USERS.resetUser);
    assert.equal((await http('POST', '/api/v1/auth/forgot-password', { body: { phone: USERS.resetUser } })).status, 200);
    const verify = await http('POST', '/api/v1/auth/verify-otp', {
      body: { phone: USERS.resetUser, otp: lastOtpFor(USERS.resetUser) },
    });
    assert.equal(verify.status, 200);
    const resetToken = verify.body.resetToken;

    const [a, b] = await Promise.all([
      http('POST', '/api/v1/auth/reset-password', { body: { resetToken, password: 'Yangi-parol-A-1' } }),
      http('POST', '/api/v1/auth/reset-password', { body: { resetToken, password: 'Yangi-parol-B-2' } }),
    ]);
    const succeeded = [a, b].filter((r) => r.status === 200);
    assert.equal(succeeded.length, 1, `exactly one reset may succeed (got ${a.status}/${b.status})`);

    const user = await db('users').where({ id: fx.ids.resetUser }).first();
    const matchesA = await bcrypt.compare('Yangi-parol-A-1', user.password_hash);
    const matchesB = await bcrypt.compare('Yangi-parol-B-2', user.password_hash);
    assert.equal(Number(matchesA) + Number(matchesB), 1, 'the stored password is exactly one candidate');

    const liveSessions = await db('sessions').where({ user_id: fx.ids.resetUser }).whereNull('revoked_at');
    assert.equal(liveSessions.length, 0, 'all sessions revoked after the successful reset');
    assert.equal((await rawHttp('GET', '/api/v1/auth/me', { headers: { cookie: preSession.cookie } })).status, 401);
  });

  // ------------------------ E. Last-admin races ---------------------------

  const withOnlyTestAdmins = async (fn: () => Promise<void>) => {
    // Temporarily block every OTHER active admin (seed/demo admins in the
    // test DB) so adminX/adminY are the only active ones. Restored after.
    const adminRole = await db('roles').where({ code: 'ADMIN' }).first();
    const others = await db('users')
      .where({ role_id: adminRole.id, status: 'ACTIVE' })
      .whereNotIn('id', [fx.ids.adminX, fx.ids.adminY])
      .select('id');
    const otherIds = others.map((o: { id: number }) => o.id);
    if (otherIds.length > 0) await db('users').whereIn('id', otherIds).update({ status: 'BLOCKED' });
    try {
      await fn();
    } finally {
      if (otherIds.length > 0) await db('users').whereIn('id', otherIds).update({ status: 'ACTIVE' });
    }
  };

  const activeAdminCount = async () => {
    const adminRole = await db('roles').where({ code: 'ADMIN' }).first();
    const rows = await db('users').where({ role_id: adminRole.id, status: 'ACTIVE' }).whereNull('deleted_at');
    return rows.length;
  };

  const restoreTestAdmins = async () => {
    const adminRole = await db('roles').where({ code: 'ADMIN' }).first();
    await db('users')
      .whereIn('id', [fx.ids.adminX, fx.ids.adminY])
      .update({ status: 'ACTIVE', role_id: adminRole.id });
  };

  await test('admin invariant: two admins blocking each other — never zero active admins', async () => {
    await withOnlyTestAdmins(async () => {
      const x = await login(USERS.adminX);
      const y = await login(USERS.adminY);
      const [a, b] = await Promise.all([
        http('POST', `/api/v1/users/${fx.ids.adminY}/block`, { cookie: x.cookie }),
        http('POST', `/api/v1/users/${fx.ids.adminX}/block`, { cookie: y.cookie }),
      ]);
      const succeeded = [a, b].filter((r) => r.status === 200).length;
      assert.equal(succeeded, 1, `exactly one block may succeed (got ${a.status}/${b.status})`);
      assert.ok((await activeAdminCount()) >= 1, 'at least one active admin must remain');
    });
    await restoreTestAdmins();
  });

  await test('admin invariant: simultaneous mutual demotions — never zero active admins', async () => {
    await withOnlyTestAdmins(async () => {
      const x = await login(USERS.adminX);
      const y = await login(USERS.adminY);
      const [a, b] = await Promise.all([
        http('PATCH', `/api/v1/users/${fx.ids.adminY}`, { cookie: x.cookie, body: { roleCode: 'USTA', branchId: fx.branchA } }),
        http('PATCH', `/api/v1/users/${fx.ids.adminX}`, { cookie: y.cookie, body: { roleCode: 'USTA', branchId: fx.branchA } }),
      ]);
      const succeeded = [a, b].filter((r) => r.status === 200).length;
      assert.equal(succeeded, 1, `exactly one demotion may succeed (got ${a.status}/${b.status})`);
      assert.ok((await activeAdminCount()) >= 1, 'at least one active admin must remain');
    });
    await restoreTestAdmins();
  });

  await test('admin invariant: mixed concurrent block + demotion — never zero active admins', async () => {
    await withOnlyTestAdmins(async () => {
      const x = await login(USERS.adminX);
      const y = await login(USERS.adminY);
      const [a, b] = await Promise.all([
        http('POST', `/api/v1/users/${fx.ids.adminY}/block`, { cookie: x.cookie }),
        http('PATCH', `/api/v1/users/${fx.ids.adminX}`, { cookie: y.cookie, body: { roleCode: 'MASTER', branchId: fx.branchA } }),
      ]);
      const succeeded = [a, b].filter((r) => r.status === 200).length;
      assert.equal(succeeded, 1, `exactly one operation may succeed (got ${a.status}/${b.status})`);
      assert.ok((await activeAdminCount()) >= 1, 'at least one active admin must remain');
    });
    await restoreTestAdmins();
  });

  // ---------------------- F. Checklist assignment -------------------------

  // The admin-invariant tests above can revoke adminX's original session
  // (a successful block revokes sessions), so re-establish a fresh admin
  // session before creating the template fixtures.
  const adminFixtures = await login(USERS.adminX);

  // Business fixtures for assignment tests
  const c = await http('POST', '/api/v1/customers', {
    cookie: ustaMain.cookie,
    body: { name: 'TEST HD Mijoz Asosiy', phone: '99 000 88 31' },
  });
  const customerId = c.body.customer.id as number;
  const mkVehicleJob = async (plate: string) => {
    const v = await http('POST', '/api/v1/vehicles', {
      cookie: ustaMain.cookie,
      body: { customerId, plateNumber: plate, make: 'Chevrolet', model: 'Damas' },
    });
    const j = await http('POST', '/api/v1/jobs', { cookie: ustaMain.cookie, body: { customerId, vehicleId: v.body.vehicle.id } });
    return j.body.job.id as number;
  };
  const t = await http('POST', '/api/v1/checklist-templates', { cookie: adminFixtures.cookie, body: { name: 'TEST HD Shablon' } });
  const templateId = t.body.template.id as number;
  const versionId = t.body.template.versions[0].id as number;
  await http('POST', `/api/v1/checklist-templates/${templateId}/versions/${versionId}/steps`, {
    cookie: adminFixtures.cookie,
    body: { name: 'Yagona bosqich' },
  });
  await http('POST', `/api/v1/checklist-templates/${templateId}/versions/${versionId}/publish`, { cookie: adminFixtures.cookie });

  await test('assignment: cancelled job refuses a checklist (state re-checked under lock)', async () => {
    const jobId = await mkVehicleJob('THD001AA');
    assert.equal(
      (await http('POST', `/api/v1/jobs/${jobId}/cancel`, { cookie: ustaMain.cookie, body: { reason: 'Sinov bekor' } })).status,
      200,
    );
    const res = await http('POST', `/api/v1/jobs/${jobId}/checklist`, { cookie: ustaMain.cookie, body: { templateId } });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'JOB_STATE_INVALID');
    assert.equal(await db('job_checklists').where({ job_id: jobId }).first(), undefined);
  });

  await test('assignment: concurrent assign/assign — one 201, one clean 409, no 500', async () => {
    const jobId = await mkVehicleJob('THD002BB');
    const [a, b] = await Promise.all([
      http('POST', `/api/v1/jobs/${jobId}/checklist`, { cookie: ustaMain.cookie, body: { templateId } }),
      http('POST', `/api/v1/jobs/${jobId}/checklist`, { cookie: ustaMain.cookie, body: { templateId } }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [201, 409], `got ${a.status}/${b.status}`);
    const loser = [a, b].find((r) => r.status === 409)!;
    assert.ok(['CHECKLIST_EXISTS', 'CONFLICT_RETRY', 'DUPLICATE'].includes(loser.body.error.code), loser.body.error.code);
    const rows = await db('job_checklists').where({ job_id: jobId });
    assert.equal(rows.length, 1, 'exactly one checklist exists');
  });

  await test('assignment: concurrent cancel vs assign stays consistent, never a 500', async () => {
    const jobId = await mkVehicleJob('THD003CC');
    const [cancelRes, assignRes] = await Promise.all([
      http('POST', `/api/v1/jobs/${jobId}/cancel`, { cookie: ustaMain.cookie, body: { reason: 'Poyga bekor' } }),
      http('POST', `/api/v1/jobs/${jobId}/checklist`, { cookie: ustaMain.cookie, body: { templateId } }),
    ]);
    assert.ok(cancelRes.status < 500 && assignRes.status < 500, `no 500s (got ${cancelRes.status}/${assignRes.status})`);
    const job = await db('jobs').where({ id: jobId }).first();
    const checklist = await db('job_checklists').where({ job_id: jobId }).first();
    if (job.status === 'CANCELLED' && checklist) {
      // Legal only when the assign committed BEFORE the cancel; the reverse
      // order (assign onto an already-cancelled job) must have returned 409.
      assert.equal(assignRes.status, 201, 'a checklist on a cancelled job implies assign won the race');
    }
  });

  // ----------------------- G. Inactive branch -----------------------------

  await test('branch policy: deactivation kills sessions, blocks logins and all work', async () => {
    const ustaSession = await login(USERS.ustaH);
    assert.equal((await rawHttp('GET', '/api/v1/auth/me', { headers: { cookie: ustaSession.cookie } })).status, 200);

    const res = await http('POST', `/api/v1/branches/${fx.branchH}/deactivate`, { cookie: adminFixtures.cookie });
    assert.equal(res.status, 200);

    // Existing session dies immediately (revoked + refused by requireAuth)
    assert.equal((await rawHttp('GET', '/api/v1/auth/me', { headers: { cookie: ustaSession.cookie } })).status, 401);
    const live = await db('sessions').where({ user_id: fx.ids.ustaH }).whereNull('revoked_at');
    assert.equal(live.length, 0, 'branch deactivation revokes its users\' sessions');

    // No new sessions, generic failure (no branch-status leak)
    const loginRes = await rawHttp('POST', '/api/v1/auth/login', {
      body: { phone: USERS.ustaH, password: PASSWORD, rememberMe: false },
    });
    assert.equal(loginRes.status, 401);
    assert.equal(loginRes.body.error.message, "Telefon raqam yoki parol noto'g'ri");
    const auditRow = await db('audit_logs')
      .where({ action: 'LOGIN_FAILED', user_id: fx.ids.ustaH })
      .orderBy('id', 'desc')
      .first();
    const auditReason = typeof auditRow.new_value === 'string' ? auditRow.new_value : JSON.stringify(auditRow.new_value);
    assert.ok(auditReason.includes('BRANCH_INACTIVE'), 'audit records the real reason');

    // No job creation / checklist mutation with the dead session
    assert.equal(
      (await http('POST', '/api/v1/jobs', { cookie: ustaSession.cookie, body: { customerId, vehicleId: 1 } })).status,
      401,
    );

    // Global roles keep read access to the deactivated branch's data
    const sifatSession = await login(USERS.sifat);
    assert.equal((await rawHttp('GET', `/api/v1/branches/${fx.branchH}`, { headers: { cookie: adminFixtures.cookie } })).status, 200);
    assert.equal((await rawHttp('GET', '/api/v1/jobs', { headers: { cookie: sifatSession.cookie } })).status, 200);

    // Reactivation restores logins
    assert.equal((await http('POST', `/api/v1/branches/${fx.branchH}/activate`, { cookie: adminFixtures.cookie })).status, 200);
    assert.equal((await login(USERS.ustaH)).cookie.length > 0, true);
  });

  // ----------------------- H. Test-DB guard -------------------------------

  await test('test-DB guard fails closed for non-test env and non-test databases', async () => {
    const fakeDb = { raw: async () => [[{ db: 'easygas' }]] };
    await assert.rejects(assertTestDatabase(fakeDb as never), /not a \*_test database/);

    const realEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      await assert.rejects(assertTestDatabase(db), /NODE_ENV/);
    } finally {
      process.env.NODE_ENV = realEnv;
    }
    await assertTestDatabase(db); // and passes for the real *_test connection
  });

  // ----------------------- I. Error mapping -------------------------------

  await test('error mapping: duplicate-key and deadlock map to stable 409s without SQL leakage', async () => {
    const capture = () => {
      const res: any = {
        statusCode: 0,
        payload: null,
        status(code: number) {
          this.statusCode = code;
          return this;
        },
        json(payload: unknown) {
          this.payload = payload;
          return this;
        },
      };
      return res;
    };

    const dup = capture();
    errorHandler(
      Object.assign(new Error("Duplicate entry 'x' for key 'uq' — SECRET SQL"), { errno: 1062, code: 'ER_DUP_ENTRY' }),
      { path: '/t', method: 'POST' } as never,
      dup,
      (() => {}) as never,
    );
    assert.equal(dup.statusCode, 409);
    assert.equal(dup.payload.error.code, 'DUPLICATE');
    assert.ok(!JSON.stringify(dup.payload).includes('SECRET SQL'), 'SQL details must not leak');

    const deadlock = capture();
    errorHandler(
      Object.assign(new Error('Deadlock found when trying to get lock'), { errno: 1213 }),
      { path: '/t', method: 'POST' } as never,
      deadlock,
      (() => {}) as never,
    );
    assert.equal(deadlock.statusCode, 409);
    assert.equal(deadlock.payload.error.code, 'CONFLICT_RETRY');
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
