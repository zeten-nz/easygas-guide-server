/**
 * EASY GAS — Phase 1 authentication end-to-end tests.
 *
 * Runs the Express app in-process against the real MySQL dev database
 * (migrations + seeds must be applied first: npm run migrate && npm run seed).
 *
 *   npm run test:auth
 *
 * Uses a capturing SMS provider so OTP codes can be asserted without a real
 * SMS gateway. All fixtures live in the +9989900099xx phone range and are
 * cleaned up before and after the run.
 */
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import { db } from '../src/config/database';
import { createApp } from '../src/app';
import { setSmsProviderForTesting } from '../src/sms';
import type { SmsProvider } from '../src/sms/sms.provider';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const PHONES = {
  usta: '+998990009901',
  blocked: '+998990009902',
  admin: '+998990009903',
  regApprove: '+998990009904',
  regReject: '+998990009905',
  regPending: '+998990009906',
  rateLimit: '+998990009907',
  usta2: '+998990009908',
};

const PASSWORD = 'Sinov-parol-123';

const smsInbox: { phone: string; message: string }[] = [];
const captureSms: SmsProvider = {
  name: 'test-capture',
  async send(phone, message) {
    smsInbox.push({ phone, message });
  },
};

function lastOtpFor(phone: string): string {
  const msg = [...smsInbox].reverse().find((m) => m.phone === phone);
  assert.ok(msg, `no SMS captured for ${phone}`);
  const otp = msg.message.match(/\b(\d{6})\b/)?.[1];
  assert.ok(otp, `no OTP found in SMS: ${msg.message}`);
  return otp;
}

let baseUrl = '';

interface HttpResult {
  status: number;
  body: any;
  setCookies: string[];
}

async function http(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string } = {},
): Promise<HttpResult> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
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

function sessionCookie(result: HttpResult): string {
  const raw = result.setCookies.find((c) => c.startsWith('eg_session='));
  assert.ok(raw, 'expected eg_session cookie');
  return raw.split(';')[0];
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
  const phones = Object.values(PHONES);
  const users = await db('users').whereIn('phone', phones).select('id');
  const userIds = users.map((u: { id: number }) => u.id);
  if (userIds.length > 0) {
    await db('audit_logs').whereIn('user_id', userIds).del();
    await db('sessions').whereIn('user_id', userIds).del();
    await db('password_resets').whereIn('user_id', userIds).del();
  }
  await db('registration_requests').whereIn('phone', phones).del();
  await db('users').whereIn('phone', phones).del();
}

async function createFixtures(): Promise<void> {
  const roles = await db('roles').select('id', 'code');
  const roleId = (code: string) => {
    const role = roles.find((r: { code: string }) => r.code === code);
    assert.ok(role, `role ${code} missing — run npm run seed first`);
    return role.id;
  };
  const branch = await db('branches').where({ status: 'ACTIVE' }).first();
  assert.ok(branch, 'no active branch — run npm run seed first');

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const base = {
    password_hash: passwordHash,
    region: 'Toshkent shahri',
    branch_id: branch.id,
  };

  await db('users').insert([
    { ...base, first_name: 'Test', last_name: 'Usta', phone: PHONES.usta, role_id: roleId('USTA'), status: 'ACTIVE' },
    { ...base, first_name: 'Test', last_name: 'Usta2', phone: PHONES.usta2, role_id: roleId('USTA'), status: 'ACTIVE' },
    { ...base, first_name: 'Test', last_name: 'Bloklangan', phone: PHONES.blocked, role_id: roleId('USTA'), status: 'BLOCKED' },
    { ...base, first_name: 'Test', last_name: 'Admin', phone: PHONES.admin, branch_id: null, role_id: roleId('ADMIN'), status: 'ACTIVE' },
  ]);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  setSmsProviderForTesting(captureSms);
  await cleanup();
  await createFixtures();

  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;

  console.log(`\nRunning auth E2E against ${baseUrl}\n`);

  // 1. Valid login
  let ustaCookie = '';
  await test('valid login returns user and sets HTTP-only session cookie', async () => {
    const res = await http('POST', '/api/v1/auth/login', {
      body: { phone: PHONES.usta, password: PASSWORD, rememberMe: false },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.role, 'USTA');
    assert.equal(res.body.user.phone, PHONES.usta);
    assert.equal(res.body.user.passwordHash, undefined);
    assert.equal(res.body.user.password_hash, undefined);
    const raw = res.setCookies.find((c) => c.startsWith('eg_session='));
    assert.ok(raw?.toLowerCase().includes('httponly'), 'cookie must be HttpOnly');
    ustaCookie = sessionCookie(res);
  });

  // 2. Invalid password → generic error
  await test('invalid password returns generic 401', async () => {
    const res = await http('POST', '/api/v1/auth/login', {
      body: { phone: PHONES.usta, password: 'notog-ri-parol', rememberMe: false },
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.message, "Telefon raqam yoki parol noto'g'ri");
  });

  // 3. Nonexistent account → identical generic error (no enumeration)
  await test('nonexistent account returns identical generic 401', async () => {
    const res = await http('POST', '/api/v1/auth/login', {
      body: { phone: '+998991234567', password: 'nimadir-parol', rememberMe: false },
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.message, "Telefon raqam yoki parol noto'g'ri");
  });

  // 4. Inactive account — since Phase 2, blocked accounts get the SAME generic
  // failure as bad credentials (a blocked user must not be able to confirm
  // their password is still valid). The audit log keeps the real reason.
  await test('blocked account gets the same generic 401 as bad credentials', async () => {
    const res = await http('POST', '/api/v1/auth/login', {
      body: { phone: PHONES.blocked, password: PASSWORD, rememberMe: false },
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.message, "Telefon raqam yoki parol noto'g'ri");
  });

  // 5. Logout revokes the session server-side
  await test('logout revokes session (subsequent /me is 401)', async () => {
    const me = await http('GET', '/api/v1/auth/me', { cookie: ustaCookie });
    assert.equal(me.status, 200);
    const out = await http('POST', '/api/v1/auth/logout', { cookie: ustaCookie });
    assert.equal(out.status, 204);
    const meAfter = await http('GET', '/api/v1/auth/me', { cookie: ustaCookie });
    assert.equal(meAfter.status, 401);
  });

  // 6. Remember me → ~6 month session
  await test('remember me creates a ~180-day persistent session', async () => {
    const res = await http('POST', '/api/v1/auth/login', {
      body: { phone: PHONES.usta, password: PASSWORD, rememberMe: true },
    });
    assert.equal(res.status, 200);
    const raw = res.setCookies.find((c) => c.startsWith('eg_session='));
    assert.ok(raw && /expires=/i.test(raw), 'remember-me cookie must be persistent (Expires set)');
    const session = await db('sessions')
      .join('users', 'users.id', 'sessions.user_id')
      .where('users.phone', PHONES.usta)
      .whereNull('sessions.revoked_at')
      .orderBy('sessions.created_at', 'desc')
      .select('sessions.*')
      .first();
    assert.ok(session, 'session row must exist');
    assert.equal(Boolean(session.remember_me), true);
    const days = (new Date(session.expires_at).getTime() - Date.now()) / 86_400_000;
    assert.ok(days > 170 && days <= 181, `expected ~180 days, got ${days.toFixed(1)}`);
    ustaCookie = sessionCookie(res);
  });

  // 7. Registration request
  await test('registration creates a PENDING request (no active account)', async () => {
    const branch = await db('branches').where({ status: 'ACTIVE' }).first();
    const res = await http('POST', '/api/v1/auth/register', {
      body: {
        firstName: 'Yangi',
        lastName: 'Talabgor',
        phone: PHONES.regPending,
        region: 'Toshkent shahri',
        branchId: branch.id,
        comment: 'Test izoh',
        password: PASSWORD,
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.request.status, 'PENDING');
    const row = await db('registration_requests').where({ phone: PHONES.regPending }).first();
    assert.equal(row.status, 'PENDING');
    assert.notEqual(row.password_hash, PASSWORD, 'password must be hashed');
    const login = await http('POST', '/api/v1/auth/login', {
      body: { phone: PHONES.regPending, password: PASSWORD, rememberMe: false },
    });
    assert.equal(login.status, 401, 'pending request must not be able to log in');
  });

  // 8. Registration validation
  await test('registration input is validated server-side (422)', async () => {
    const res = await http('POST', '/api/v1/auth/register', {
      body: { firstName: 'A', lastName: '', phone: '12345', region: '', branchId: -1, password: 'qisqa' },
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    assert.ok(Array.isArray(res.body.error.details) && res.body.error.details.length >= 3);
  });

  // Admin login used by approval/rejection scenarios
  let adminCookie = '';
  await test('admin can log in', async () => {
    const res = await http('POST', '/api/v1/auth/login', {
      body: { phone: PHONES.admin, password: PASSWORD, rememberMe: false },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.role, 'ADMIN');
    adminCookie = sessionCookie(res);
  });

  // 9. Admin approval
  await test('admin approval activates the account (backend-enforced)', async () => {
    const branch = await db('branches').where({ status: 'ACTIVE' }).first();
    const reg = await http('POST', '/api/v1/auth/register', {
      body: {
        firstName: 'Tasdiq',
        lastName: 'Sinov',
        phone: PHONES.regApprove,
        region: 'Samarqand',
        branchId: branch.id,
        password: PASSWORD,
      },
    });
    assert.equal(reg.status, 201);
    const id = reg.body.request.id;

    const approve = await http('POST', `/api/v1/admin/registration-requests/${id}/approve`, {
      cookie: adminCookie,
      body: { roleCode: 'USTA' },
    });
    assert.equal(approve.status, 200);

    const row = await db('registration_requests').where({ id }).first();
    assert.equal(row.status, 'APPROVED');
    assert.ok(row.created_user_id, 'created_user_id must be linked');

    const login = await http('POST', '/api/v1/auth/login', {
      body: { phone: PHONES.regApprove, password: PASSWORD, rememberMe: false },
    });
    assert.equal(login.status, 200, 'approved user must be able to log in');
    assert.equal(login.body.user.role, 'USTA');

    const again = await http('POST', `/api/v1/admin/registration-requests/${id}/approve`, {
      cookie: adminCookie,
      body: { roleCode: 'USTA' },
    });
    assert.equal(again.status, 409, 'double approval must be rejected');
  });

  // 10. Admin rejection
  await test('admin rejection keeps the user unable to log in', async () => {
    const branch = await db('branches').where({ status: 'ACTIVE' }).first();
    const reg = await http('POST', '/api/v1/auth/register', {
      body: {
        firstName: 'Rad',
        lastName: 'Sinov',
        phone: PHONES.regReject,
        region: 'Buxoro',
        branchId: branch.id,
        password: PASSWORD,
      },
    });
    assert.equal(reg.status, 201);
    const id = reg.body.request.id;

    const noReason = await http('POST', `/api/v1/admin/registration-requests/${id}/reject`, {
      cookie: adminCookie,
      body: { reason: '' },
    });
    assert.equal(noReason.status, 422, 'rejection reason must be mandatory');

    const reject = await http('POST', `/api/v1/admin/registration-requests/${id}/reject`, {
      cookie: adminCookie,
      body: { reason: "Ma'lumotlar tasdiqlanmadi" },
    });
    assert.equal(reject.status, 200);

    const row = await db('registration_requests').where({ id }).first();
    assert.equal(row.status, 'REJECTED');

    const login = await http('POST', '/api/v1/auth/login', {
      body: { phone: PHONES.regReject, password: PASSWORD, rememberMe: false },
    });
    assert.equal(login.status, 401, 'rejected request must not create an account');
  });

  // 11. Password reset validation
  await test('reset validation: wrong OTP and garbage token are rejected', async () => {
    const forgot = await http('POST', '/api/v1/auth/forgot-password', { body: { phone: PHONES.usta } });
    assert.equal(forgot.status, 200);

    const wrongOtp = await http('POST', '/api/v1/auth/verify-otp', {
      body: { phone: PHONES.usta, otp: '000000' },
    });
    // The real OTP is random 6 digits; 000000 collides with probability 1e-6.
    assert.equal(wrongOtp.status, 400);

    const badToken = await http('POST', '/api/v1/auth/reset-password', {
      body: { resetToken: 'f'.repeat(64), password: 'Yangi-parol-123' },
    });
    assert.equal(badToken.status, 400);

    const malformed = await http('POST', '/api/v1/auth/verify-otp', {
      body: { phone: PHONES.usta, otp: 'abc' },
    });
    assert.equal(malformed.status, 422);
  });

  // 12. OTP expiration
  await test('expired OTP is rejected', async () => {
    const forgot = await http('POST', '/api/v1/auth/forgot-password', { body: { phone: PHONES.usta2 } });
    assert.equal(forgot.status, 200);
    const otp = lastOtpFor(PHONES.usta2);

    await db('password_resets')
      .where({ phone: PHONES.usta2 })
      .whereNull('consumed_at')
      .update({ otp_expires_at: new Date(Date.now() - 1000) });

    const res = await http('POST', '/api/v1/auth/verify-otp', { body: { phone: PHONES.usta2, otp } });
    assert.equal(res.status, 400);
  });

  // 13. OTP single-use + full reset flow
  let resetToken = '';
  await test('OTP is single-use; full reset changes password and revokes sessions', async () => {
    const forgot = await http('POST', '/api/v1/auth/forgot-password', { body: { phone: PHONES.usta } });
    assert.equal(forgot.status, 200);
    const otp = lastOtpFor(PHONES.usta);

    const ok = await http('POST', '/api/v1/auth/verify-otp', { body: { phone: PHONES.usta, otp } });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.resetToken);
    resetToken = ok.body.resetToken;

    const reuse = await http('POST', '/api/v1/auth/verify-otp', { body: { phone: PHONES.usta, otp } });
    assert.equal(reuse.status, 400, 'consumed OTP must not verify again');

    const newPassword = 'Yangi-parol-456';
    const reset = await http('POST', '/api/v1/auth/reset-password', {
      body: { resetToken, password: newPassword },
    });
    assert.equal(reset.status, 200);

    const tokenReuse = await http('POST', '/api/v1/auth/reset-password', {
      body: { resetToken, password: 'Yana-boshqa-789' },
    });
    assert.equal(tokenReuse.status, 400, 'reset token must be single-use');

    const meAfter = await http('GET', '/api/v1/auth/me', { cookie: ustaCookie });
    assert.equal(meAfter.status, 401, 'existing sessions must be revoked after password reset');

    const oldLogin = await http('POST', '/api/v1/auth/login', {
      body: { phone: PHONES.usta, password: PASSWORD, rememberMe: false },
    });
    assert.equal(oldLogin.status, 401, 'old password must no longer work');

    const newLogin = await http('POST', '/api/v1/auth/login', {
      body: { phone: PHONES.usta, password: newPassword, rememberMe: false },
    });
    assert.equal(newLogin.status, 200, 'new password must work');
    ustaCookie = sessionCookie(newLogin);
  });

  // 14. OTP rate limiting + attempt limiting
  await test('forgot-password is rate-limited per phone (3 per 15 min)', async () => {
    for (let i = 0; i < 3; i += 1) {
      const res = await http('POST', '/api/v1/auth/forgot-password', { body: { phone: PHONES.rateLimit } });
      assert.equal(res.status, 200, `request ${i + 1} should pass`);
    }
    const fourth = await http('POST', '/api/v1/auth/forgot-password', { body: { phone: PHONES.rateLimit } });
    assert.equal(fourth.status, 429);
  });

  await test('OTP verification attempts are limited per code', async () => {
    const forgot = await http('POST', '/api/v1/auth/forgot-password', { body: { phone: PHONES.usta2 } });
    assert.equal(forgot.status, 200);
    const otp = lastOtpFor(PHONES.usta2);

    for (let i = 0; i < 5; i += 1) {
      const res = await http('POST', '/api/v1/auth/verify-otp', {
        body: { phone: PHONES.usta2, otp: '111111' === otp ? '222222' : '111111' },
      });
      assert.equal(res.status, 400, `wrong attempt ${i + 1} should be 400`);
    }
    const exceeded = await http('POST', '/api/v1/auth/verify-otp', { body: { phone: PHONES.usta2, otp } });
    assert.equal(exceeded.status, 429, 'correct OTP after attempt limit must be refused');
  });

  // 15. Protected endpoint without authentication
  await test('protected endpoints require authentication', async () => {
    const me = await http('GET', '/api/v1/auth/me');
    assert.equal(me.status, 401);
    const admin = await http('GET', '/api/v1/admin/registration-requests');
    assert.equal(admin.status, 401);
    const badCookie = await http('GET', '/api/v1/auth/me', { cookie: `eg_session=${'a'.repeat(64)}` });
    assert.equal(badCookie.status, 401);
  });

  // 16. Role-protected endpoint with wrong role
  await test('USTA cannot access ADMIN registration endpoints (403)', async () => {
    const list = await http('GET', '/api/v1/admin/registration-requests', { cookie: ustaCookie });
    assert.equal(list.status, 403);
    const approve = await http('POST', '/api/v1/admin/registration-requests/1/approve', {
      cookie: ustaCookie,
      body: { roleCode: 'ADMIN' },
    });
    assert.equal(approve.status, 403);
  });

  // Audit trail sanity
  await test('audit log records authentication events', async () => {
    const actions = await db('audit_logs')
      .join('users', 'users.id', 'audit_logs.user_id')
      .whereIn('users.phone', Object.values(PHONES))
      .distinct('audit_logs.action')
      .pluck('audit_logs.action');
    for (const expected of ['LOGIN', 'LOGIN_FAILED', 'LOGOUT', 'PASSWORD_RESET_REQUESTED', 'PASSWORD_RESET', 'USER_APPROVED', 'USER_REJECTED']) {
      assert.ok(actions.includes(expected), `missing audit action ${expected}`);
    }
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
