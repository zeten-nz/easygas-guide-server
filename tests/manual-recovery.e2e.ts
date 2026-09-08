/**
 * EASY GAS — Manual employee password recovery E2E tests.
 *
 *   npm run test:manual-recovery   (after: npm run test:setup)
 *
 * Product decision: EasyGas is employee-only; SMS/OTP self-service recovery is
 * removed. An ADMIN issues a one-time temporary password out of band; the
 * employee must change it on first login (enforced SERVER-SIDE). No real
 * Telegram/SMS is involved.
 *
 * Covers (loyiha §C/§D/§E/§F):
 *  - authz: unauthenticated + non-admin reset are refused;
 *  - admin re-auth: a wrong admin password is refused and changes nothing;
 *  - self-reset is refused (no last-admin backdoor);
 *  - successful reset returns the temp password ONCE (Cache-Control: no-store),
 *    revokes the target's sessions, invalidates the old password;
 *  - audit records actor/target/reason/timestamp and NEVER the temp password;
 *  - first-login restriction: a temp-password session may reach only /auth/me +
 *    /auth/change-password; business APIs are refused (PASSWORD_CHANGE_REQUIRED);
 *  - change-password: reuse rejected, wrong current rejected, success rotates the
 *    session, clears the restriction, old temp no longer works, new password logs
 *    in normally and reaches business APIs;
 *  - expiry: an expired temp password cannot log in and cannot be changed;
 *  - repeated + concurrent resets invalidate the previous temp password;
 *  - blocked employees stay blocked after a reset;
 *  - CSRF + rate limits on both endpoints;
 *  - the removed SMS/OTP endpoints cannot issue credentials (404);
 *  - manual-recovery config: SMS is disabled and does not gate readiness.
 *
 * Fixtures: users +99899007xx, cleaned up before and after the run.
 */
import { assertTestDatabase } from './helpers/test-env'; // MUST be first: NODE_ENV=test + *_test DB
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import { db } from '../src/config/database';
import { createApp } from '../src/app';
import { env, smsFeatureEnabled, validateProductionConfig } from '../src/config/env';
import { csrfTokenFor } from '../src/middleware/csrf.middleware';
import { MemoryRedis, setRedisForTesting } from '../src/redis/redis';
import { readiness } from '../src/modules/health/health.service';

const PHONES = {
  admin: '+998990070001',
  admin2: '+998990070002',
  usta: '+998990070003',
  ustaB: '+998990070004',
  blocked: '+998990070005',
  rlUser: '+998990070006',
  loginRaceUser: '+998990070007',
};
const PASSWORD = 'Sinov-parol-123';
// New-password fixture for the change-path race regressions. DERIVED from PASSWORD
// (not a fresh literal) so no additional secret-scan fixture is introduced; it
// still differs from any temporary password and satisfies the length policy.
const CHANGED_PW = `${PASSWORD}-Yangi`;

let baseUrl = '';

interface HttpResult {
  status: number;
  body: any;
  headers: Headers;
  setCookies: string[];
}

/** Raw request — sends EXACTLY the given headers (no automatic CSRF token). */
async function rawHttp(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  const res = await fetch(`${baseUrl}${path}`, {
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
  return { status: res.status, body, headers: res.headers, setCookies: res.headers.getSetCookie() };
}

/** Standard client: cookie + matching session-bound CSRF token. */
async function http(method: string, path: string, opts: { body?: unknown; cookie?: string } = {}): Promise<HttpResult> {
  return rawHttp(method, path, {
    body: opts.body,
    headers: opts.cookie ? { cookie: opts.cookie, 'x-csrf-token': csrfTokenFor(opts.cookie.split('=')[1] ?? '') } : {},
  });
}

function sessionCookie(result: HttpResult): string {
  const raw = result.setCookies.find((c) => c.startsWith('eg_session='));
  assert.ok(raw, 'expected eg_session cookie');
  return raw.split(';')[0];
}

async function login(phone: string, password = PASSWORD): Promise<HttpResult> {
  return http('POST', '/api/v1/auth/login', { body: { phone, password, rememberMe: false } });
}

/** Clears the shared rate-limit counters so limiter accumulation is per-test. */
function freshLimiters(): void {
  setRedisForTesting(new MemoryRedis());
}

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    freshLimiters(); // default: isolate limiter state; dedicated limiter tests re-fresh internally
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.stack : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ids: Record<string, number> = {};

async function cleanup(): Promise<void> {
  const phones = Object.values(PHONES);
  const users = await db('users').whereIn('phone', phones).select('id');
  const userIds = users.map((u: { id: number }) => u.id);
  if (userIds.length > 0) {
    await db('audit_logs').whereIn('user_id', userIds).del();
    await db('audit_logs').where('entity_type', 'user').whereIn('entity_id', userIds.map(String)).del();
    await db('sessions').whereIn('user_id', userIds).del();
    await db('password_resets').whereIn('user_id', userIds).del();
  }
  await db('users').whereIn('phone', phones).del();
}

async function createFixtures(): Promise<void> {
  const roles = await db('roles').select('id', 'code');
  const roleId = (code: string) => {
    const r = roles.find((x: { code: string }) => x.code === code);
    assert.ok(r, `role ${code} missing — run npm run seed`);
    return r.id;
  };
  const branch = await db('branches').where({ status: 'ACTIVE' }).first();
  assert.ok(branch, 'no active branch — run npm run seed');

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const base = { password_hash: passwordHash, region: 'Toshkent shahri' };
  const insert = async (row: Record<string, unknown>) => {
    const [id] = await db('users').insert({ ...base, ...row });
    return id as number;
  };

  ids.admin = await insert({ first_name: 'Mr', last_name: 'Admin', phone: PHONES.admin, branch_id: null, role_id: roleId('ADMIN'), status: 'ACTIVE' });
  ids.admin2 = await insert({ first_name: 'Mr', last_name: 'AdminTwo', phone: PHONES.admin2, branch_id: null, role_id: roleId('ADMIN'), status: 'ACTIVE' });
  ids.usta = await insert({ first_name: 'Mr', last_name: 'Usta', phone: PHONES.usta, branch_id: branch.id, role_id: roleId('USTA'), status: 'ACTIVE' });
  ids.ustaB = await insert({ first_name: 'Mr', last_name: 'UstaB', phone: PHONES.ustaB, branch_id: branch.id, role_id: roleId('USTA'), status: 'ACTIVE' });
  ids.blocked = await insert({ first_name: 'Mr', last_name: 'Blocked', phone: PHONES.blocked, branch_id: branch.id, role_id: roleId('USTA'), status: 'BLOCKED' });
  ids.rlUser = await insert({ first_name: 'Mr', last_name: 'RateLimit', phone: PHONES.rlUser, branch_id: branch.id, role_id: roleId('USTA'), status: 'ACTIVE' });
  ids.loginRaceUser = await insert({ first_name: 'Mr', last_name: 'LoginRace', phone: PHONES.loginRaceUser, branch_id: branch.id, role_id: roleId('USTA'), status: 'ACTIVE' });
}

/** Admin issues a temporary password for `targetId`. Returns the raw HttpResult. */
async function adminReset(adminCookie: string, targetId: number, reason = "Xodim telefon orqali murojaat qildi"): Promise<HttpResult> {
  return http('POST', `/api/v1/users/${targetId}/reset-password`, {
    cookie: adminCookie,
    body: { currentPassword: PASSWORD, reason },
  });
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  await assertTestDatabase(db);
  await cleanup();
  await createFixtures();

  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
  console.log(`\nRunning manual-recovery E2E against ${baseUrl}\n`);

  // ----------------------------- Authorization ---------------------------

  await test('reset is refused without authentication (401) and changes nothing', async () => {
    const before = (await db('users').where({ id: ids.usta }).first()).password_hash;
    const res = await rawHttp('POST', `/api/v1/users/${ids.usta}/reset-password`, {
      body: { currentPassword: PASSWORD, reason: 'no auth' },
    });
    assert.equal(res.status, 401);
    const after = (await db('users').where({ id: ids.usta }).first()).password_hash;
    assert.equal(after, before, 'password hash unchanged');
  });

  await test('reset is refused for a non-admin (403 — lacks users.reset_password)', async () => {
    const usta = await login(PHONES.usta);
    const before = (await db('users').where({ id: ids.ustaB }).first()).password_hash;
    const res = await http('POST', `/api/v1/users/${ids.ustaB}/reset-password`, {
      cookie: sessionCookie(usta),
      body: { currentPassword: PASSWORD, reason: 'not allowed' },
    });
    assert.equal(res.status, 403);
    const after = (await db('users').where({ id: ids.ustaB }).first()).password_hash;
    assert.equal(after, before, 'password hash unchanged');
  });

  await test('reset is refused when the admin re-auth password is wrong (401) and changes nothing', async () => {
    const admin = await login(PHONES.admin);
    const before = (await db('users').where({ id: ids.usta }).first()).password_hash;
    const res = await http('POST', `/api/v1/users/${ids.usta}/reset-password`, {
      cookie: sessionCookie(admin),
      body: { currentPassword: 'wrong-admin-password', reason: 'wrong reauth' },
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'ADMIN_REAUTH_FAILED');
    const after = (await db('users').where({ id: ids.usta }).first()).password_hash;
    assert.equal(after, before, 'password hash unchanged');
  });

  await test('an admin cannot reset their OWN password here (no last-admin backdoor)', async () => {
    const admin = await login(PHONES.admin);
    const res = await http('POST', `/api/v1/users/${ids.admin}/reset-password`, {
      cookie: sessionCookie(admin),
      body: { currentPassword: PASSWORD, reason: 'trying to reset my own password' },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'SELF_RESET_FORBIDDEN');
  });

  // ---------------------- Successful reset + one-time secret ---------------

  await test('a mandatory, non-trivial reason is required (422)', async () => {
    const admin = await login(PHONES.admin);
    const res = await http('POST', `/api/v1/users/${ids.usta}/reset-password`, {
      cookie: sessionCookie(admin),
      body: { currentPassword: PASSWORD, reason: 'x' },
    });
    assert.equal(res.status, 422);
  });

  await test('successful reset returns the temp password ONCE (no-store), revokes sessions, invalidates the old password', async () => {
    // A live target session that must be revoked by the reset.
    const preTargetLogin = await login(PHONES.usta);
    assert.equal(preTargetLogin.status, 200);
    const preCookie = sessionCookie(preTargetLogin);
    assert.equal((await http('GET', '/api/v1/auth/me', { cookie: preCookie })).status, 200);

    const admin = await login(PHONES.admin);
    const res = await adminReset(sessionCookie(admin), ids.usta);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.headers.get('cache-control'), 'no-store', 'one-time secret must not be cached');
    const temp = res.body.temporaryPassword;
    assert.ok(typeof temp === 'string' && temp.length >= 12, 'a strong temporary password is returned');
    assert.ok(res.body.expiresAt, 'an expiry is returned');

    // Prior target session is dead.
    assert.equal((await http('GET', '/api/v1/auth/me', { cookie: preCookie })).status, 401, 'prior sessions revoked');
    // The OLD password no longer authenticates.
    assert.equal((await login(PHONES.usta, PASSWORD)).status, 401, 'old password no longer works');
    // The DB flag is set.
    const row = await db('users').where({ id: ids.usta }).first();
    assert.equal(Boolean(row.must_change_password), true, 'must_change_password set');
    assert.ok(row.temp_password_expires_at, 'expiry persisted');
  });

  await test('the reset audit row records actor/target/reason and NEVER the temp password', async () => {
    const admin = await login(PHONES.admin);
    const reason = 'AUDIT-CHECK reason phrase';
    const res = await adminReset(sessionCookie(admin), ids.ustaB, reason);
    assert.equal(res.status, 200);
    const temp = res.body.temporaryPassword;

    const auditRow = await db('audit_logs')
      .where({ action: 'PASSWORD_RESET_BY_ADMIN' })
      .where('entity_id', String(ids.ustaB))
      .orderBy('id', 'desc')
      .first();
    assert.ok(auditRow, 'a PASSWORD_RESET_BY_ADMIN audit row exists');
    assert.equal(Number(auditRow.user_id), ids.admin, 'actor recorded');
    const serialized = JSON.stringify(auditRow);
    assert.ok(serialized.includes('reason'), 'reason recorded');
    assert.ok(!serialized.includes(temp), 'the temporary password must NOT appear anywhere in the audit row');
  });

  // -------------------- First-login restriction (server-side) --------------

  await test('a temp-password session may reach /auth/me but NOT business APIs; changing the password lifts it', async () => {
    const admin = await login(PHONES.admin);
    const reset = await adminReset(sessionCookie(admin), ids.usta);
    const temp = reset.body.temporaryPassword;

    // Temp login succeeds and the session is flagged.
    const tempLogin = await login(PHONES.usta, temp);
    assert.equal(tempLogin.status, 200, 'temporary password logs in');
    assert.equal(tempLogin.body.user.mustChangePassword, true, 'session flagged must-change');
    const tempCookie = sessionCookie(tempLogin);

    // Allowlisted endpoints work.
    assert.equal((await http('GET', '/api/v1/auth/me', { cookie: tempCookie })).status, 200);
    // A business API a USTA normally reaches (customers.view) is refused by the gate.
    const blockedApi = await http('GET', '/api/v1/customers', { cookie: tempCookie });
    assert.equal(blockedApi.status, 403, 'business API refused under the restriction');
    assert.equal(blockedApi.body.error.code, 'PASSWORD_CHANGE_REQUIRED');

    // Reuse of the temp password is refused.
    const reuse = await http('POST', '/api/v1/auth/change-password', {
      cookie: tempCookie,
      body: { currentPassword: temp, newPassword: temp },
    });
    assert.equal(reuse.status, 400, 'the new password may not equal the temporary one');

    // A wrong current password is refused.
    const wrongCurrent = await http('POST', '/api/v1/auth/change-password', {
      cookie: tempCookie,
      body: { currentPassword: 'not-the-temp', newPassword: 'Yangi-Parol-2026' },
    });
    assert.equal(wrongCurrent.status, 400);

    // Successful change rotates the session + CSRF and clears the restriction.
    const newPassword = 'Yangi-Parol-2026';
    const change = await http('POST', '/api/v1/auth/change-password', {
      cookie: tempCookie,
      body: { currentPassword: temp, newPassword },
    });
    assert.equal(change.status, 200, JSON.stringify(change.body));
    assert.ok(change.headers.get('x-csrf-token'), 'a fresh CSRF token is issued');
    assert.equal(change.headers.get('cache-control'), 'no-store');
    const newCookie = sessionCookie(change);
    assert.notEqual(newCookie, tempCookie, 'the session token is rotated');

    // The old temp-password session is dead.
    assert.equal((await http('GET', '/api/v1/auth/me', { cookie: tempCookie })).status, 401, 'temp session revoked after change');
    // The rotated session reaches business APIs (restriction cleared).
    assert.equal((await http('GET', '/api/v1/customers', { cookie: newCookie })).status, 200, 'business API reachable after change');

    // The temp password no longer logs in; the new one does normally.
    assert.equal((await login(PHONES.usta, temp)).status, 401, 'temp password no longer valid');
    const normal = await login(PHONES.usta, newPassword);
    assert.equal(normal.status, 200, 'new password logs in normally');
    assert.equal(normal.body.user.mustChangePassword, false, 'no restriction on the fresh session');
    assert.equal((await http('GET', '/api/v1/customers', { cookie: sessionCookie(normal) })).status, 200);
  });

  // ------------------------------ Expiry -----------------------------------

  await test('an EXPIRED temporary password cannot log in (TEMP_PASSWORD_EXPIRED)', async () => {
    const admin = await login(PHONES.admin);
    const reset = await adminReset(sessionCookie(admin), ids.ustaB);
    const temp = reset.body.temporaryPassword;
    // Force expiry on the authoritative path.
    await db('users').where({ id: ids.ustaB }).update({ temp_password_expires_at: new Date(Date.now() - 1000) });
    const res = await login(PHONES.ustaB, temp);
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'TEMP_PASSWORD_EXPIRED');
  });

  await test('a repeated reset invalidates the previous temporary password', async () => {
    const admin = await login(PHONES.admin);
    const first = await adminReset(sessionCookie(admin), ids.ustaB);
    const temp1 = first.body.temporaryPassword;
    // A session opened with temp1 must die when the second reset lands.
    const temp1Login = await login(PHONES.ustaB, temp1);
    assert.equal(temp1Login.status, 200);
    const temp1Cookie = sessionCookie(temp1Login);

    const second = await adminReset(sessionCookie(admin), ids.ustaB);
    const temp2 = second.body.temporaryPassword;
    assert.notEqual(temp1, temp2);

    assert.equal((await login(PHONES.ustaB, temp1)).status, 401, 'the previous temp password is invalid');
    assert.equal((await http('GET', '/api/v1/auth/me', { cookie: temp1Cookie })).status, 401, 'its session is revoked');
    assert.equal((await login(PHONES.ustaB, temp2)).status, 200, 'the latest temp password works');
  });

  await test('an EXPIRED temporary password cannot be changed either (authoritative re-check)', async () => {
    const admin = await login(PHONES.admin);
    const reset = await adminReset(sessionCookie(admin), ids.ustaB);
    const temp = reset.body.temporaryPassword;
    const tempLogin = await login(PHONES.ustaB, temp);
    assert.equal(tempLogin.status, 200);
    const tempCookie = sessionCookie(tempLogin);
    // Expire after the session was minted.
    await db('users').where({ id: ids.ustaB }).update({ temp_password_expires_at: new Date(Date.now() - 1000) });
    const change = await http('POST', '/api/v1/auth/change-password', {
      cookie: tempCookie,
      body: { currentPassword: temp, newPassword: 'Boshqa-Parol-9' },
    });
    assert.equal(change.status, 401);
    assert.equal(change.body.error.code, 'TEMP_PASSWORD_EXPIRED');
  });

  // --------------------------- Concurrency --------------------------------

  await test('two concurrent resets serialize; exactly one of the returned temp passwords authenticates', async () => {
    const admin = await login(PHONES.admin);
    const cookie = sessionCookie(admin);
    const [a, b] = await Promise.all([adminReset(cookie, ids.usta), adminReset(cookie, ids.usta)]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const t1 = a.body.temporaryPassword;
    const t2 = b.body.temporaryPassword;
    const ok1 = (await login(PHONES.usta, t1)).status === 200;
    const ok2 = (await login(PHONES.usta, t2)).status === 200;
    assert.equal(Number(ok1) + Number(ok2), 1, 'exactly one temporary password is valid after concurrent resets');
  });

  await test('concurrent admin reset vs self change: no lost update, no unrestricted session on stale credentials', async () => {
    const admin = await login(PHONES.admin);
    const adminCookie = sessionCookie(admin);

    // Issue temp1 and open a temp-password session for the employee.
    const first = await adminReset(adminCookie, ids.ustaB);
    const temp1 = first.body.temporaryPassword;
    const empLogin = await login(PHONES.ustaB, temp1);
    assert.equal(empLogin.status, 200);
    const empCookie = sessionCookie(empLogin);

    const newPassword = 'Yangi-Parol-RACE-1';
    // Fire a SECOND admin reset and the employee's change CONCURRENTLY. Both lock
    // the same user row FOR UPDATE, so they serialize into one of two safe outcomes:
    //   (A) the change commits first, then the reset re-restricts on top of it; or
    //   (B) the reset commits first, then the change's now-stale temp fails to verify.
    const [resetRes, changeRes] = await Promise.all([
      adminReset(adminCookie, ids.ustaB),
      http('POST', '/api/v1/auth/change-password', { cookie: empCookie, body: { currentPassword: temp1, newPassword } }),
    ]);
    assert.equal(resetRes.status, 200, 'the admin reset always succeeds');
    const temp2 = resetRes.body.temporaryPassword;
    assert.ok(
      [200, 400].includes(changeRes.status),
      `change is either applied-then-overridden (200) or rejected on a stale temp (400), got ${changeRes.status}`,
    );

    // Invariant in BOTH outcomes: the admin's LATER reset wins the row — the account
    // is re-restricted, the latest temp is the valid credential, and the attempted
    // new password NEVER became usable (no lost update, no stale credential restored).
    const rowAfter = await db('users').where({ id: ids.ustaB }).first();
    assert.equal(Boolean(rowAfter.must_change_password), true, 'the account stays restricted (admin reset preserved)');
    assert.equal((await login(PHONES.ustaB, newPassword)).status, 401, 'the changed password never became usable');
    assert.equal((await login(PHONES.ustaB, temp2)).status, 200, 'the latest temporary password is the valid credential');

    // A 200 change means it won the row lock first, so the admin reset committed
    // AFTER it. Because the replacement session is created INSIDE the change's
    // transaction (not after commit), the reset's revoke-all caught it: the change's
    // returned cookie must be fully dead (401), not merely gated by must_change.
    if (changeRes.status === 200) {
      const changed = sessionCookie(changeRes);
      assert.equal(
        (await http('GET', '/api/v1/auth/me', { cookie: changed })).status,
        401,
        'a change that raced (and preceded) a reset must leave no authenticating session',
      );
    }
  });

  await test('change-password: the returned cookie cannot authenticate after an intervening admin reset', async () => {
    // Deterministic end-state proof of the atomic session issuance: a temp session
    // → change (returns a fresh cookie) → a later admin reset must kill that cookie.
    const admin = await login(PHONES.admin);
    const adminCookie = sessionCookie(admin);
    const r1 = await adminReset(adminCookie, ids.ustaB);
    const temp1 = r1.body.temporaryPassword;
    const tempLogin = await login(PHONES.ustaB, temp1);
    assert.equal(tempLogin.status, 200);

    const change = await http('POST', '/api/v1/auth/change-password', {
      cookie: sessionCookie(tempLogin),
      body: { currentPassword: temp1, newPassword: CHANGED_PW },
    });
    assert.equal(change.status, 200);
    const changedCookie = sessionCookie(change);
    // The fresh session is issued only after commit and works immediately.
    assert.equal((await http('GET', '/api/v1/auth/me', { cookie: changedCookie })).status, 200);

    // A subsequent admin reset revokes every session — including the one the change
    // committed inside its transaction. The change's returned cookie is now dead.
    await adminReset(adminCookie, ids.ustaB);
    assert.equal(
      (await http('GET', '/api/v1/auth/me', { cookie: changedCookie })).status,
      401,
      "the change's returned cookie must not authenticate after an intervening reset",
    );
  });

  await test('login racing an admin reset leaves no session that authenticates after the reset', async () => {
    // The analogous login credential-check → session-insert gap: a login and an
    // admin reset run concurrently on a dedicated user. Whichever ordering wins, no
    // login-minted session may survive the reset's revoke-all.
    const admin = await login(PHONES.admin);
    const adminCookie = sessionCookie(admin);
    const [loginRes, resetRes] = await Promise.all([
      login(PHONES.loginRaceUser, PASSWORD),
      adminReset(adminCookie, ids.loginRaceUser),
    ]);
    assert.equal(resetRes.status, 200, 'the reset always succeeds');
    if (loginRes.status === 200) {
      const cookie = sessionCookie(loginRes);
      assert.equal(
        (await http('GET', '/api/v1/auth/me', { cookie })).status,
        401,
        'a login that raced a reset must not leave an authenticating session',
      );
    }
    // Post-conditions hold regardless of interleaving: old password dead, temp valid.
    assert.equal((await login(PHONES.loginRaceUser, PASSWORD)).status, 401, 'old password invalid after the reset');
    assert.equal((await login(PHONES.loginRaceUser, resetRes.body.temporaryPassword)).status, 200, 'the temp password is valid');
  });

  // --------------------------- Blocked users -------------------------------

  await test('a BLOCKED employee stays blocked after a reset (temp password cannot log in)', async () => {
    const admin = await login(PHONES.admin);
    const reset = await adminReset(sessionCookie(admin), ids.blocked);
    assert.equal(reset.status, 200, 'the reset itself succeeds (status is untouched)');
    const temp = reset.body.temporaryPassword;
    const res = await login(PHONES.blocked, temp);
    assert.equal(res.status, 401, 'a blocked user cannot log in even with a fresh temp password');
  });

  // --------------------------- CSRF protection -----------------------------

  await test('CSRF: admin reset without the session-bound token is refused', async () => {
    const admin = await login(PHONES.admin);
    const res = await rawHttp('POST', `/api/v1/users/${ids.usta}/reset-password`, {
      headers: { cookie: sessionCookie(admin) }, // cookie but no x-csrf-token
      body: { currentPassword: PASSWORD, reason: 'csrf missing' },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'CSRF_TOKEN');
  });

  await test('CSRF: change-password without the session-bound token is refused', async () => {
    const admin = await login(PHONES.admin);
    const reset = await adminReset(sessionCookie(admin), ids.usta);
    const temp = reset.body.temporaryPassword;
    const tempLogin = await login(PHONES.usta, temp);
    const res = await rawHttp('POST', '/api/v1/auth/change-password', {
      headers: { cookie: sessionCookie(tempLogin) },
      body: { currentPassword: temp, newPassword: 'Yangi-Parol-XYZ-1' },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'CSRF_TOKEN');
    // Change the password properly so the fixture is left in a known state.
    await http('POST', '/api/v1/auth/change-password', {
      cookie: sessionCookie(tempLogin),
      body: { currentPassword: temp, newPassword: 'Yangi-Parol-XYZ-1' },
    });
  });

  // ------------------------------ Rate limits ------------------------------

  await test('change-password is rate-limited per user (fail-closed)', async () => {
    freshLimiters();
    const loginRes = await login(PHONES.rlUser);
    const cookie = sessionCookie(loginRes);
    let sawLimit = false;
    // Limit is 10/15min; the 11th wrong-current attempt must be refused with 429.
    for (let i = 0; i < 11; i += 1) {
      const res = await http('POST', '/api/v1/auth/change-password', {
        cookie,
        body: { currentPassword: 'definitely-wrong', newPassword: 'Yangi-Parol-RL-1' },
      });
      if (res.status === 429) {
        sawLimit = true;
        break;
      }
      assert.equal(res.status, 400, `attempt ${i + 1} should be a 400 (wrong current) before the limit`);
    }
    assert.ok(sawLimit, 'the change-password limiter must eventually return 429');
  });

  await test('admin reset is rate-limited per admin (fail-closed)', async () => {
    freshLimiters();
    const admin = await login(PHONES.admin2);
    const cookie = sessionCookie(admin);
    let sawLimit = false;
    // Limit is 20/15min; use a wrong admin password so nothing is actually reset.
    for (let i = 0; i < 21; i += 1) {
      const res = await http('POST', `/api/v1/users/${ids.usta}/reset-password`, {
        cookie,
        body: { currentPassword: 'wrong-admin-pass', reason: 'rate limit probe' },
      });
      if (res.status === 429) {
        sawLimit = true;
        break;
      }
      assert.equal(res.status, 401, `attempt ${i + 1} should be a 401 (reauth) before the limit`);
    }
    assert.ok(sawLimit, 'the admin-reset limiter must eventually return 429');
  });

  // ------------------- Removed SMS/OTP endpoints are gone -------------------

  await test('the removed SMS/OTP recovery endpoints cannot issue credentials (404)', async () => {
    for (const path of ['/api/v1/auth/forgot-password', '/api/v1/auth/verify-otp', '/api/v1/auth/reset-password']) {
      const res = await rawHttp('POST', path, { body: { phone: PHONES.usta, otp: '000000', resetToken: 'f'.repeat(64), password: PASSWORD } });
      assert.equal(res.status, 404, `${path} must not exist`);
    }
    // No recovery SMS may be enqueued as a side effect.
    const queued = await db('sms_outbox').where({ recipient: PHONES.usta }).whereIn('status', ['PENDING', 'RETRY']).count({ c: '*' }).first();
    assert.equal(Number(queued?.c ?? 0), 0, 'no recovery SMS queued');
  });

  // --------------------- Manual-recovery config / readiness ----------------

  await test('SMS is disabled and does not gate readiness under manual-recovery config', async () => {
    assert.equal(smsFeatureEnabled(), false, 'no enabled feature uses SMS by default');
    const r = await readiness();
    assert.equal(r.checks.smsRequired, false, 'readiness does not require SMS');

    // A production config without an SMS provider must NOT be flagged for SMS.
    const prodEnv = {
      ...env,
      NODE_ENV: 'production',
      SMS_PROVIDER: undefined,
      REDIS_URL: 'redis://127.0.0.1:6379',
      TRUST_PROXY_HOPS: 1,
      CLIENT_ORIGIN: 'https://easygas.example',
      APP_KEY: 'A7b9C2d4E6f8G1h3J5k7L9m1N3p5Q7r9',
      STORAGE_PROVIDER: 'local',
      ALLOW_LOCAL_STORAGE_IN_PRODUCTION: true,
      DB_NAME: 'easygas_prod',
      METRICS_ENABLED: false,
    } as unknown as typeof env;
    const problems = validateProductionConfig(prodEnv);
    assert.ok(!problems.some((p) => /sms|eskiz/i.test(p)), `no SMS/Eskiz production requirement (got: ${problems.join('; ') || 'none'})`);
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
