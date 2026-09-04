/**
 * EASY GAS — Phase 2 RBAC + user & branch management end-to-end tests.
 *
 * Runs the Express app in-process against the real MySQL dev database
 * (migrations + seeds must be applied first).
 *
 *   npm run test:rbac
 *
 * Fixtures live in the +99899000098xx phone range / "TEST RBAC" branch names
 * and are cleaned up before and after the run.
 */
import { assertTestDatabase } from './helpers/test-env'; // MUST be first: NODE_ENV=test + *_test DB
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import { db } from '../src/config/database';
import { createApp } from '../src/app';
import { csrfTokenFor } from '../src/middleware/csrf.middleware';
import { setSmsProviderForTesting } from '../src/sms';

const PHONES = {
  admin: '+998990009801',
  rahbarA: '+998990009802',
  ustaA: '+998990009803',
  master: '+998990009804',
  sifat: '+998990009805',
  createdByAdmin: '+998990009806',
  createdByRahbar: '+998990009807',
  blockTarget: '+998990009808',
  ustaB: '+998990009809',
  scopeDenied: '+998990009810',
};

const BRANCH_A = 'TEST RBAC Branch A';
const BRANCH_B = 'TEST RBAC Branch B';
const BRANCH_NEW = 'TEST RBAC Yangi filial';

const PASSWORD = 'Sinov-parol-123';

let baseUrl = '';

interface HttpResult {
  status: number;
  body: any;
  setCookies: string[];
}

async function http(method: string, path: string, opts: { body?: unknown; cookie?: string } = {}): Promise<HttpResult> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.cookie ? { cookie: opts.cookie, 'x-csrf-token': csrfTokenFor(opts.cookie.split('=')[1] ?? '') } : {}),
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

async function login(phone: string, password = PASSWORD): Promise<string> {
  const res = await http('POST', '/api/v1/auth/login', { body: { phone, password, rememberMe: false } });
  assert.equal(res.status, 200, `login failed for ${phone}: ${JSON.stringify(res.body)}`);
  return sessionCookie(res);
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
  const testBranchIds = (await db('branches').where('name', 'like', 'TEST RBAC%').select('id')).map(
    (b: { id: number }) => String(b.id),
  );
  if (testBranchIds.length > 0) {
    await db('audit_logs').where('entity_type', 'branch').whereIn('entity_id', testBranchIds).del();
  }
  await db('branches').where('name', 'like', 'TEST RBAC%').del();
}

interface Fixtures {
  branchA: number;
  branchB: number;
  ids: Record<string, number>;
}

async function createFixtures(): Promise<Fixtures> {
  const roles = await db('roles').select('id', 'code');
  const roleId = (code: string) => {
    const role = roles.find((r: { code: string }) => r.code === code);
    assert.ok(role, `role ${code} missing — run npm run seed first`);
    return role.id;
  };

  const [branchA] = await db('branches').insert({ name: BRANCH_A, region: 'Toshkent shahri', status: 'ACTIVE' });
  const [branchB] = await db('branches').insert({ name: BRANCH_B, region: 'Samarqand', status: 'ACTIVE' });

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const base = { password_hash: passwordHash, region: 'Toshkent shahri' };

  const insert = async (row: Record<string, unknown>) => {
    const [id] = await db('users').insert(row);
    return id as number;
  };

  const ids: Record<string, number> = {};
  ids.admin = await insert({ ...base, first_name: 'Rbac', last_name: 'Admin', phone: PHONES.admin, branch_id: null, role_id: roleId('ADMIN'), status: 'ACTIVE' });
  ids.rahbarA = await insert({ ...base, first_name: 'Rbac', last_name: 'Rahbar', phone: PHONES.rahbarA, branch_id: branchA, role_id: roleId('RAHBAR'), status: 'ACTIVE' });
  ids.ustaA = await insert({ ...base, first_name: 'Rbac', last_name: 'UstaA', phone: PHONES.ustaA, branch_id: branchA, role_id: roleId('USTA'), status: 'ACTIVE' });
  ids.master = await insert({ ...base, first_name: 'Rbac', last_name: 'Master', phone: PHONES.master, branch_id: branchA, role_id: roleId('MASTER'), status: 'ACTIVE' });
  ids.sifat = await insert({ ...base, first_name: 'Rbac', last_name: 'Sifat', phone: PHONES.sifat, branch_id: null, role_id: roleId('SIFAT'), status: 'ACTIVE' });
  ids.blockTarget = await insert({ ...base, first_name: 'Rbac', last_name: 'Bloklanuvchi', phone: PHONES.blockTarget, branch_id: branchA, role_id: roleId('USTA'), status: 'ACTIVE' });
  ids.ustaB = await insert({ ...base, first_name: 'Rbac', last_name: 'UstaB', phone: PHONES.ustaB, branch_id: branchB, role_id: roleId('USTA'), status: 'ACTIVE' });

  return { branchA: branchA as number, branchB: branchB as number, ids };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  setSmsProviderForTesting({ name: 'test-capture', send: async () => ({ providerMessageId: null, outcome: 'ACCEPTED' as const }) });
  await assertTestDatabase(db);
  await cleanup();
  const fx = await createFixtures();

  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;

  console.log(`\nRunning RBAC E2E against ${baseUrl}\n`);

  const adminCookie = await login(PHONES.admin);
  const rahbarCookie = await login(PHONES.rahbarA);
  const ustaCookie = await login(PHONES.ustaA);
  const masterCookie = await login(PHONES.master);
  const sifatCookie = await login(PHONES.sifat);

  // 1. ADMIN can list users
  await test('ADMIN can list users with pagination and filters', async () => {
    const res = await http('GET', '/api/v1/users?limit=100', { cookie: adminCookie });
    assert.equal(res.status, 200);
    assert.ok(typeof res.body.total === 'number' && res.body.total >= 7);
    const phones = res.body.users.map((u: any) => u.phone);
    assert.ok(phones.includes(PHONES.ustaA) && phones.includes(PHONES.ustaB));

    const filtered = await http('GET', `/api/v1/users?role=USTA&branchId=${fx.branchB}&limit=100`, {
      cookie: adminCookie,
    });
    assert.equal(filtered.status, 200);
    assert.ok(filtered.body.users.every((u: any) => u.role === 'USTA' && u.branchId === fx.branchB));
    assert.ok(filtered.body.users.some((u: any) => u.phone === PHONES.ustaB));

    const searched = await http('GET', '/api/v1/users?search=Bloklanuvchi', { cookie: adminCookie });
    assert.ok(searched.body.users.some((u: any) => u.phone === PHONES.blockTarget));
  });

  // 2. Unauthorized callers cannot list users
  await test('unauthenticated (401) and permissionless roles (403) cannot list users', async () => {
    assert.equal((await http('GET', '/api/v1/users')).status, 401);
    assert.equal((await http('GET', '/api/v1/users', { cookie: ustaCookie })).status, 403);
    assert.equal((await http('GET', '/api/v1/users', { cookie: masterCookie })).status, 403);
    assert.equal((await http('GET', '/api/v1/users', { cookie: sifatCookie })).status, 403);
  });

  // 3. ADMIN can create a user
  await test('ADMIN can create a user with any role/branch; new user can log in', async () => {
    const res = await http('POST', '/api/v1/users', {
      cookie: adminCookie,
      body: {
        firstName: 'Yaratilgan',
        lastName: 'AdminTomonidan',
        phone: PHONES.createdByAdmin,
        region: 'Buxoro',
        branchId: fx.branchB,
        roleCode: 'MASTER',
        password: PASSWORD,
      },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.user.role, 'MASTER');
    assert.equal(res.body.user.branchId, fx.branchB);
    await login(PHONES.createdByAdmin);

    const dup = await http('POST', '/api/v1/users', {
      cookie: adminCookie,
      body: {
        firstName: 'Dublikat',
        lastName: 'Telefon',
        phone: PHONES.createdByAdmin,
        region: 'Buxoro',
        branchId: fx.branchB,
        roleCode: 'USTA',
        password: PASSWORD,
      },
    });
    assert.equal(dup.status, 409, 'duplicate phone must be refused');
  });

  // 4. RAHBAR can create users — scoped to own branch, technician roles only
  await test('RAHBAR creates USTA into their own branch (branch is forced)', async () => {
    const res = await http('POST', '/api/v1/users', {
      cookie: rahbarCookie,
      body: {
        firstName: 'Yaratilgan',
        lastName: 'RahbarTomonidan',
        phone: PHONES.createdByRahbar,
        region: 'Toshkent shahri',
        roleCode: 'USTA',
        password: PASSWORD,
      },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.user.branchId, fx.branchA, 'must be forced into the rahbar branch');
    await login(PHONES.createdByRahbar);
  });

  await test('RAHBAR cannot create a user in another branch', async () => {
    const res = await http('POST', '/api/v1/users', {
      cookie: rahbarCookie,
      body: {
        firstName: 'Chet',
        lastName: 'Filial',
        phone: PHONES.scopeDenied,
        region: 'Samarqand',
        branchId: fx.branchB,
        roleCode: 'USTA',
        password: PASSWORD,
      },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'BRANCH_SCOPE');
  });

  await test('RAHBAR cannot create ADMIN/SIFAT/RAHBAR (no escalation)', async () => {
    for (const roleCode of ['ADMIN', 'SIFAT', 'RAHBAR']) {
      const res = await http('POST', '/api/v1/users', {
        cookie: rahbarCookie,
        body: {
          firstName: 'Eskalatsiya',
          lastName: 'Urinish',
          phone: PHONES.scopeDenied,
          region: 'Toshkent shahri',
          roleCode,
          password: PASSWORD,
        },
      });
      assert.equal(res.status, 403, `${roleCode} must be refused`);
      assert.equal(res.body.error.code, 'ROLE_NOT_ALLOWED');
    }
  });

  // 5-7. Other roles cannot create users
  await test('USTA, MASTER, SIFAT cannot create users (403)', async () => {
    for (const cookie of [ustaCookie, masterCookie, sifatCookie]) {
      const res = await http('POST', '/api/v1/users', {
        cookie,
        body: {
          firstName: 'Ruxsatsiz',
          lastName: 'Yaratish',
          phone: PHONES.scopeDenied,
          region: 'Toshkent shahri',
          roleCode: 'USTA',
          branchId: fx.branchA,
          password: PASSWORD,
        },
      });
      assert.equal(res.status, 403);
    }
  });

  // 8. No self-escalation
  await test('USTA cannot assign ADMIN to themselves (403, no users.update)', async () => {
    const res = await http('PATCH', `/api/v1/users/${fx.ids.ustaA}`, {
      cookie: ustaCookie,
      body: { roleCode: 'ADMIN' },
    });
    assert.equal(res.status, 403);
    const check = await http('GET', '/api/v1/auth/me', { cookie: ustaCookie });
    assert.equal(check.body.user.role, 'USTA', 'role must be unchanged');
  });

  // 9. IDOR — modifying another user by guessing IDs
  await test('USTA cannot modify or block another user via direct IDs (403)', async () => {
    assert.equal(
      (await http('PATCH', `/api/v1/users/${fx.ids.master}`, { cookie: ustaCookie, body: { firstName: 'Buzildi' } }))
        .status,
      403,
    );
    assert.equal((await http('POST', `/api/v1/users/${fx.ids.master}/block`, { cookie: ustaCookie })).status, 403);
    const untouched = await http('GET', `/api/v1/users/${fx.ids.master}`, { cookie: adminCookie });
    assert.equal(untouched.body.user.firstName, 'Rbac');
  });

  // 10. RAHBAR branch scoping on reads
  await test('RAHBAR sees only own-branch users; cross-branch reads 404', async () => {
    const list = await http('GET', `/api/v1/users?limit=100&branchId=${fx.branchB}`, { cookie: rahbarCookie });
    assert.equal(list.status, 200);
    assert.ok(list.body.users.length > 0);
    assert.ok(
      list.body.users.every((u: any) => u.branchId === fx.branchA),
      'branch filter must be forced to the rahbar branch',
    );
    const other = await http('GET', `/api/v1/users/${fx.ids.ustaB}`, { cookie: rahbarCookie });
    assert.equal(other.status, 404, 'cross-branch user must be invisible');
  });

  // 11-12. Blocking
  let blockTargetCookie = '';
  await test('ADMIN blocks a user: sessions revoked immediately', async () => {
    blockTargetCookie = await login(PHONES.blockTarget);
    assert.equal((await http('GET', '/api/v1/auth/me', { cookie: blockTargetCookie })).status, 200);

    const res = await http('POST', `/api/v1/users/${fx.ids.blockTarget}/block`, { cookie: adminCookie });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.status, 'BLOCKED');

    assert.equal(
      (await http('GET', '/api/v1/auth/me', { cookie: blockTargetCookie })).status,
      401,
      'existing session must be dead',
    );

    const again = await http('POST', `/api/v1/users/${fx.ids.blockTarget}/block`, { cookie: adminCookie });
    assert.equal(again.status, 409, 'double block must be refused');
  });

  await test('blocked user cannot log in (generic failure)', async () => {
    const res = await http('POST', '/api/v1/auth/login', {
      body: { phone: PHONES.blockTarget, password: PASSWORD, rememberMe: false },
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.message, "Telefon raqam yoki parol noto'g'ri");
  });

  // 13. Unblocking
  await test('ADMIN unblocks the user; login works again', async () => {
    const res = await http('POST', `/api/v1/users/${fx.ids.blockTarget}/unblock`, { cookie: adminCookie });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.status, 'ACTIVE');
    await login(PHONES.blockTarget);
  });

  // 14-15. Role change + immediate effect + audit
  await test('ADMIN changes role; change is effective immediately and audited', async () => {
    const res = await http('PATCH', `/api/v1/users/${fx.ids.ustaA}`, {
      cookie: adminCookie,
      body: { roleCode: 'MASTER', branchId: fx.branchA },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.user.role, 'MASTER');

    // The user's existing session picks up the new role/permissions at once
    // (requireAuth reloads from DB per request — no stale role in a token).
    const me = await http('GET', '/api/v1/auth/me', { cookie: ustaCookie });
    assert.equal(me.body.user.role, 'MASTER');
    assert.ok(me.body.user.permissions.includes('stops.approve'));

    const audit = await db('audit_logs')
      .where({ action: 'USER_ROLE_CHANGED', entity_type: 'user', entity_id: String(fx.ids.ustaA) })
      .orderBy('id', 'desc')
      .first();
    assert.ok(audit, 'USER_ROLE_CHANGED audit row must exist');
    assert.equal(audit.user_id, fx.ids.admin, 'actor must be recorded');
    const oldVal = typeof audit.old_value === 'string' ? JSON.parse(audit.old_value) : audit.old_value;
    const newVal = typeof audit.new_value === 'string' ? JSON.parse(audit.new_value) : audit.new_value;
    assert.equal(oldVal.role, 'USTA');
    assert.equal(newVal.role, 'MASTER');
  });

  // 16. Admin safety
  await test('admin safety: self-block and self-role-change are refused', async () => {
    const selfBlock = await http('POST', `/api/v1/users/${fx.ids.admin}/block`, { cookie: adminCookie });
    assert.equal(selfBlock.status, 409);
    assert.equal(selfBlock.body.error.code, 'SELF_BLOCK');

    const selfRole = await http('PATCH', `/api/v1/users/${fx.ids.admin}`, {
      cookie: adminCookie,
      body: { roleCode: 'USTA' },
    });
    assert.equal(selfRole.status, 409);
    assert.equal(selfRole.body.error.code, 'SELF_ROLE_CHANGE');
  });

  // 17. Branch management
  let newBranchId = 0;
  await test('ADMIN manages branches: create, duplicate check, update, deactivate, activate', async () => {
    const created = await http('POST', '/api/v1/branches', {
      cookie: adminCookie,
      body: { name: BRANCH_NEW, region: 'Namangan', address: 'Test manzil', phone: '+998 69 200 00 00' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    newBranchId = created.body.branch.id;
    assert.equal(created.body.branch.status, 'ACTIVE');

    const dup = await http('POST', '/api/v1/branches', {
      cookie: adminCookie,
      body: { name: BRANCH_NEW.toLowerCase(), region: 'Namangan' },
    });
    assert.equal(dup.status, 409, 'duplicate branch name must be refused');

    const updated = await http('PATCH', `/api/v1/branches/${newBranchId}`, {
      cookie: adminCookie,
      body: { address: 'Yangi manzil' },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.branch.address, 'Yangi manzil');

    const deactivated = await http('POST', `/api/v1/branches/${newBranchId}/deactivate`, { cookie: adminCookie });
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.branch.status, 'INACTIVE');

    // Inactive branches: hidden from the public sign-up list, refused for new users
    const publicList = await http('GET', '/api/v1/branches');
    assert.ok(!publicList.body.branches.some((b: any) => b.id === newBranchId));
    const intoInactive = await http('POST', '/api/v1/users', {
      cookie: adminCookie,
      body: {
        firstName: 'Faolmas',
        lastName: 'Filialga',
        phone: PHONES.scopeDenied,
        region: 'Namangan',
        branchId: newBranchId,
        roleCode: 'USTA',
        password: PASSWORD,
      },
    });
    assert.equal(intoInactive.status, 400, 'cannot assign users to an INACTIVE branch');

    // Admin management list still shows it (with full fields)
    const manageList = await http('GET', '/api/v1/branches', { cookie: adminCookie });
    const row = manageList.body.branches.find((b: any) => b.id === newBranchId);
    assert.ok(row && row.status === 'INACTIVE' && 'userCount' in row);

    const activated = await http('POST', `/api/v1/branches/${newBranchId}/activate`, { cookie: adminCookie });
    assert.equal(activated.status, 200);
    assert.equal(activated.body.branch.status, 'ACTIVE');
  });

  // 18. Unauthorized branch modification
  await test('unauthorized callers cannot modify branches', async () => {
    assert.equal((await http('POST', '/api/v1/branches', { body: { name: 'X', region: 'Y' } })).status, 401);
    for (const cookie of [ustaCookie, masterCookie, rahbarCookie, sifatCookie]) {
      assert.equal(
        (await http('POST', '/api/v1/branches', { cookie, body: { name: 'Hack filial', region: 'Toshkent shahri' } }))
          .status,
        403,
      );
      assert.equal(
        (await http('PATCH', `/api/v1/branches/${fx.branchA}`, { cookie, body: { name: 'Buzilgan' } })).status,
        403,
      );
    }
    const unchanged = await db('branches').where({ id: fx.branchA }).first();
    assert.equal(unchanged.name, BRANCH_A);
  });

  // 19. Referenced branches cannot be hard-deleted
  await test('referenced branch cannot be hard-deleted (no route; FK RESTRICT)', async () => {
    assert.equal(
      (await http('DELETE', `/api/v1/branches/${fx.branchA}`, { cookie: adminCookie })).status,
      404,
      'there must be no DELETE route',
    );
    await assert.rejects(
      db('branches').where({ id: fx.branchA }).del(),
      /foreign key constraint/i,
      'DB must refuse deleting a branch referenced by users',
    );
  });

  // 20. Audit completeness
  await test('all Phase 2 actions are audited with the correct actor', async () => {
    const expectActions: [string, string][] = [
      ['USER_CREATED', 'user'],
      ['USER_BLOCKED', 'user'],
      ['USER_UNBLOCKED', 'user'],
      ['USER_ROLE_CHANGED', 'user'],
      ['BRANCH_CREATED', 'branch'],
      ['BRANCH_UPDATED', 'branch'],
      ['BRANCH_DEACTIVATED', 'branch'],
      ['BRANCH_ACTIVATED', 'branch'],
    ];
    for (const [action, entityType] of expectActions) {
      const row = await db('audit_logs')
        .where({ action, entity_type: entityType })
        .whereIn('user_id', [fx.ids.admin, fx.ids.rahbarA])
        .orderBy('id', 'desc')
        .first();
      assert.ok(row, `missing audit action ${action}`);
      assert.ok(row.user_id, `audit ${action} must record the actor`);
    }
    // RAHBAR's user creation is attributed to the rahbar, not an admin
    const rahbarCreate = await db('audit_logs')
      .where({ action: 'USER_CREATED', user_id: fx.ids.rahbarA })
      .first();
    assert.ok(rahbarCreate, 'rahbar-created user must be audited with rahbar as actor');
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
