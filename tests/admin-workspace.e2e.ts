/**
 * EASY GAS — Phase 11A admin workspace: employee directory, profiles, and safe
 * template deletion end-to-end tests.
 *
 *   npm run test:admin-workspace   (after: npm run test:setup)
 *
 * Covers (loyiha §B/§C/§D/§7):
 *  - directory pagination: deterministic order (created_at desc, id desc tie-break),
 *    bounded limits, accurate filtered totals across pages;
 *  - the CURRENT viewer is excluded from their own directory (before COUNT), while
 *    another administrator remains visible;
 *  - own-profile (GET /users/me) works for a role WITHOUT users.view;
 *  - employee-profile authorization: branch boundaries, out-of-scope + nonexistent
 *    ids both 404 (never 403), forced-change sessions cannot reach these endpoints;
 *  - permanently delete an UNUSED draft-only template; unauthorized delete refused;
 *  - a published/archived (history-bearing) template cannot be deleted;
 *  - concurrent delete vs publish is safe (exactly one outcome, never corruption);
 *  - a TEMPLATE_DELETED audit event is recorded without step internals.
 *
 * Fixtures: users +99899008xx, branches/templates "TEST AW ...". Cleaned before + after.
 */
import { assertTestDatabase } from './helpers/test-env'; // MUST be first: NODE_ENV=test + *_test DB
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import { db } from '../src/config/database';
import { createApp } from '../src/app';
import { csrfTokenFor } from '../src/middleware/csrf.middleware';

const PHONES = {
  admin: '+998990080001',
  admin2: '+998990080002',
  rahbar: '+998990080003',
  ustaOutside: '+998990080004',
  mustChange: '+998990080005',
};
const DIR_COUNT = 12;
const dirPhone = (i: number) => `+9989900800${String(10 + i).padStart(2, '0')}`; // +99899008001x/002x
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

function sessionCookie(res: HttpResult): string {
  const raw = res.setCookies.find((c) => c.startsWith('eg_session='));
  assert.ok(raw, 'expected eg_session cookie');
  return raw.split(';')[0];
}

async function login(phone: string, password = PASSWORD): Promise<HttpResult> {
  return http('POST', '/api/v1/auth/login', { body: { phone, password, rememberMe: false } });
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
    console.error(`        ${err instanceof Error ? err.stack : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ids: Record<string, number> = {};
const dirIds: number[] = [];

async function cleanup(): Promise<void> {
  // Any template built by the tests ("TEST AW …").
  const tplIds = (await db('checklist_templates').where('name', 'like', 'TEST AW%').select('id')).map((t: { id: number }) => t.id);
  if (tplIds.length) {
    const verIds = (await db('checklist_template_versions').whereIn('template_id', tplIds).select('id')).map((v: { id: number }) => v.id);
    if (verIds.length) {
      const stepIds = (await db('checklist_steps').whereIn('version_id', verIds).select('id')).map((s: { id: number }) => s.id);
      if (stepIds.length) {
        await db('checklist_step_measurements').whereIn('step_id', stepIds).del();
        await db('checklist_steps').whereIn('id', stepIds).del();
      }
      await db('audit_logs').where('entity_type', 'checklist_template_version').whereIn('entity_id', verIds.map(String)).del();
      await db('checklist_template_versions').whereIn('id', verIds).del();
    }
    await db('audit_logs').where('entity_type', 'checklist_template').whereIn('entity_id', tplIds.map(String)).del();
    await db('checklist_templates').whereIn('id', tplIds).del();
  }

  const phones = [...Object.values(PHONES), ...Array.from({ length: DIR_COUNT }, (_, i) => dirPhone(i))];
  const users = await db('users').whereIn('phone', phones).select('id');
  const userIds = users.map((u: { id: number }) => u.id);
  if (userIds.length) {
    await db('audit_logs').whereIn('user_id', userIds).del();
    await db('audit_logs').where('entity_type', 'user').whereIn('entity_id', userIds.map(String)).del();
    await db('sessions').whereIn('user_id', userIds).del();
    await db('password_resets').whereIn('user_id', userIds).del();
  }
  await db('users').whereIn('phone', phones).del();
  const brIds = (await db('branches').where('name', 'like', 'TEST AW%').select('id')).map((b: { id: number }) => String(b.id));
  if (brIds.length) await db('audit_logs').where('entity_type', 'branch').whereIn('entity_id', brIds).del();
  await db('branches').where('name', 'like', 'TEST AW%').del();
}

async function createFixtures(): Promise<void> {
  const roles = await db('roles').select('id', 'code');
  const roleId = (code: string) => {
    const r = roles.find((x: { code: string }) => x.code === code);
    assert.ok(r, `role ${code} missing`);
    return r.id;
  };
  const [awBranch] = await db('branches').insert({ name: 'TEST AW Branch', region: 'Toshkent shahri', status: 'ACTIVE' });
  const [aw2Branch] = await db('branches').insert({ name: 'TEST AW Branch 2', region: 'Samarqand', status: 'ACTIVE' });
  ids.awBranch = awBranch as number;
  ids.aw2Branch = aw2Branch as number;

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const base = { password_hash: passwordHash, region: 'Toshkent shahri' };
  const insert = async (row: Record<string, unknown>) => {
    const [id] = await db('users').insert({ ...base, ...row });
    return id as number;
  };

  ids.admin = await insert({ first_name: 'Aw', last_name: 'Admin', phone: PHONES.admin, branch_id: null, role_id: roleId('ADMIN'), status: 'ACTIVE' });
  ids.admin2 = await insert({ first_name: 'Aw', last_name: 'AdminTwo', phone: PHONES.admin2, branch_id: null, role_id: roleId('ADMIN'), status: 'ACTIVE' });
  ids.rahbar = await insert({ first_name: 'Aw', last_name: 'Rahbar', phone: PHONES.rahbar, branch_id: awBranch, role_id: roleId('RAHBAR'), status: 'ACTIVE' });
  ids.ustaOutside = await insert({ first_name: 'Aw', last_name: 'Outside', phone: PHONES.ustaOutside, branch_id: aw2Branch, role_id: roleId('USTA'), status: 'ACTIVE' });

  // A forced-change session fixture (ACTIVE, non-expired temporary password).
  const tempHash = await bcrypt.hash('Vaqtinchalik-1', 10);
  ids.mustChange = await insert({
    first_name: 'Aw',
    last_name: 'MustChange',
    phone: PHONES.mustChange,
    branch_id: aw2Branch,
    role_id: roleId('USTA'),
    status: 'ACTIVE',
    password_hash: tempHash,
    must_change_password: true,
    temp_password_expires_at: new Date(Date.now() + 3_600_000),
  });

  // 12 directory USTA users in branch AW, ALL with an identical created_at so the
  // pagination order relies entirely on the id tie-breaker (deterministic id-desc).
  const sameCreatedAt = new Date('2026-01-01T00:00:00Z');
  for (let i = 0; i < DIR_COUNT; i++) {
    const id = await insert({
      first_name: 'Dir',
      last_name: `Xodim${String(i).padStart(2, '0')}`,
      phone: dirPhone(i),
      branch_id: awBranch,
      role_id: roleId('USTA'),
      status: i === 0 ? 'BLOCKED' : 'ACTIVE', // one blocked, to exercise the status filter
      created_at: sameCreatedAt,
    });
    dirIds.push(id);
  }
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
  await new Promise<void>((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  console.log(`\nRunning admin-workspace E2E against ${baseUrl}\n`);

  // -------------------------- Directory pagination -------------------------

  await test('directory (RAHBAR): branch-scoped, deterministic paging with accurate total, no dupes/omissions', async () => {
    const rahbar = sessionCookie(await login(PHONES.rahbar));
    const limit = 5;
    const seen: number[] = [];
    let page = 1;
    let total = -1;
    for (;;) {
      const res = await http('GET', `/api/v1/users?limit=${limit}&page=${page}&excludeSelf=true`, { cookie: rahbar });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      total = res.body.total;
      for (const u of res.body.users) seen.push(u.id);
      if (page * limit >= total) break;
      page += 1;
      if (page > 20) throw new Error('too many pages');
    }
    // 12 branch-AW directory users; the RAHBAR excludes self → total 12.
    assert.equal(total, DIR_COUNT, `expected total ${DIR_COUNT}, got ${total}`);
    assert.equal(seen.length, DIR_COUNT, 'every row appears exactly once across pages');
    assert.equal(new Set(seen).size, DIR_COUNT, 'no duplicate rows across pages');
    // The RAHBAR never appears in their own directory.
    assert.ok(!seen.includes(ids.rahbar), 'the current viewer is excluded from their own directory');
    // Only branch-AW users (never the cross-branch outside user).
    assert.ok(!seen.includes(ids.ustaOutside), 'cross-branch users are not listed for a branch-scoped viewer');
    assert.deepEqual([...seen].sort((a, b) => a - b), [...dirIds].sort((a, b) => a - b), 'exactly the branch-AW directory users');
  });

  await test('directory order is deterministic under an identical created_at (id-desc tie-breaker)', async () => {
    const rahbar = sessionCookie(await login(PHONES.rahbar));
    const a = await http('GET', '/api/v1/users?limit=50&excludeSelf=true', { cookie: rahbar });
    const b = await http('GET', '/api/v1/users?limit=50&excludeSelf=true', { cookie: rahbar });
    const orderA = a.body.users.map((u: any) => u.id);
    const orderB = b.body.users.map((u: any) => u.id);
    assert.deepEqual(orderA, orderB, 'two identical requests return an identical order');
    // All share created_at 2026-01-01, so the tie-breaker sorts them strictly by id desc.
    const descById = [...dirIds].sort((x, y) => y - x);
    assert.deepEqual(orderA, descById, 'rows with equal created_at are ordered by id desc');
  });

  await test('directory filters (status/role/search) narrow the total accurately', async () => {
    const rahbar = sessionCookie(await login(PHONES.rahbar));
    const blocked = await http('GET', '/api/v1/users?status=BLOCKED&limit=50&excludeSelf=true', { cookie: rahbar });
    assert.equal(blocked.body.total, 1, 'one blocked directory user');
    assert.equal(blocked.body.users[0].status, 'BLOCKED');
    const byRole = await http('GET', '/api/v1/users?role=MASTER&limit=50&excludeSelf=true', { cookie: rahbar });
    assert.equal(byRole.body.total, 0, 'no MASTER directory users');
    const search = await http('GET', '/api/v1/users?search=Xodim05&limit=50&excludeSelf=true', { cookie: rahbar });
    assert.equal(search.body.total, 1, 'search matches exactly one');
    assert.equal(search.body.users[0].lastName, 'Xodim05');
  });

  await test('directory limit is bounded: >100 and <1 are rejected (422)', async () => {
    const rahbar = sessionCookie(await login(PHONES.rahbar));
    assert.equal((await http('GET', '/api/v1/users?limit=1000', { cookie: rahbar })).status, 422, 'limit > 100 rejected');
    assert.equal((await http('GET', '/api/v1/users?limit=0', { cookie: rahbar })).status, 422, 'limit < 1 rejected');
    assert.equal((await http('GET', '/api/v1/users?limit=50', { cookie: rahbar })).body.limit, 50, 'limit 50 honored');
  });

  await test('directory (ADMIN): the current admin is excluded, but another admin remains visible', async () => {
    const admin = sessionCookie(await login(PHONES.admin));
    const seen: number[] = [];
    let page = 1;
    for (;;) {
      const res = await http('GET', `/api/v1/users?limit=100&page=${page}&excludeSelf=true`, { cookie: admin });
      assert.equal(res.status, 200);
      for (const u of res.body.users) seen.push(u.id);
      if (page * 100 >= res.body.total) break;
      page += 1;
      if (page > 50) throw new Error('too many pages');
    }
    assert.ok(!seen.includes(ids.admin), 'the signed-in admin is not in their own directory');
    assert.ok(seen.includes(ids.admin2), 'a different administrator is still visible');
    assert.ok(seen.includes(ids.rahbar) && seen.includes(ids.ustaOutside), 'admin sees all branches');
  });

  await test('exclusion is OPT-IN: without excludeSelf, GET /users still includes the caller (general lookup unchanged)', async () => {
    const rahbar = sessionCookie(await login(PHONES.rahbar));
    // No excludeSelf → the RAHBAR sees their whole branch INCLUDING themselves (13),
    // proving the endpoint's default semantics are untouched for other consumers.
    const withSelf = await http('GET', '/api/v1/users?limit=50', { cookie: rahbar });
    assert.equal(withSelf.status, 200);
    assert.ok(withSelf.body.users.some((u: any) => u.id === ids.rahbar), 'the caller is present by default');
    assert.equal(withSelf.body.total, DIR_COUNT + 1, 'default total includes the caller');
    // excludeSelf=false behaves the same as omitting it.
    const explicitFalse = await http('GET', '/api/v1/users?limit=50&excludeSelf=false', { cookie: rahbar });
    assert.ok(explicitFalse.body.users.some((u: any) => u.id === ids.rahbar), "excludeSelf=false keeps the caller");
  });

  // ------------------------------ Own profile ------------------------------

  await test('own profile (GET /users/me) works for a role WITHOUT users.view and returns the caller', async () => {
    // A plain directory USTA has no users.view, but may view their own profile.
    const ustaCookie = sessionCookie(await login(dirPhone(1))); // an ACTIVE dir USTA
    const noList = await http('GET', '/api/v1/users?limit=5', { cookie: ustaCookie });
    assert.equal(noList.status, 403, 'a USTA has no users.view (cannot list the directory)');
    const me = await http('GET', '/api/v1/users/me', { cookie: ustaCookie });
    assert.equal(me.status, 200, 'but can read their own profile');
    assert.equal(me.body.user.id, dirIds[1], 'own profile returns the caller');
    assert.equal(me.body.user.phone, dirPhone(1));
    assert.equal(me.body.user.branchName, 'TEST AW Branch');
  });

  // --------------------------- Employee profile authz ----------------------

  await test('employee profile authorization: branch boundary, 404 (not 403) for out-of-scope + nonexistent', async () => {
    const rahbar = sessionCookie(await login(PHONES.rahbar));
    const admin = sessionCookie(await login(PHONES.admin));

    // RAHBAR can read an own-branch employee.
    assert.equal((await http('GET', `/api/v1/users/${dirIds[1]}`, { cookie: rahbar })).status, 200);
    // RAHBAR reading a CROSS-branch user → 404 (not 403), so ids can't be probed.
    const cross = await http('GET', `/api/v1/users/${ids.ustaOutside}`, { cookie: rahbar });
    assert.equal(cross.status, 404, 'out-of-branch read is 404, not 403');
    // A cross-branch ADMIN (branch null) is also invisible to the RAHBAR → 404.
    assert.equal((await http('GET', `/api/v1/users/${ids.admin2}`, { cookie: rahbar })).status, 404);
    // Nonexistent id → 404.
    assert.equal((await http('GET', '/api/v1/users/99999999', { cookie: rahbar })).status, 404);
    // ADMIN can read any branch's user.
    assert.equal((await http('GET', `/api/v1/users/${ids.ustaOutside}`, { cookie: admin })).status, 200);
    // A USTA (no users.view) cannot read arbitrary profiles at all.
    const ustaCookie = sessionCookie(await login(dirPhone(1)));
    assert.equal((await http('GET', `/api/v1/users/${dirIds[2]}`, { cookie: ustaCookie })).status, 403);
  });

  await test('a forced-change (temporary-password) session cannot reach the directory or profiles', async () => {
    const tempLogin = await login(PHONES.mustChange, 'Vaqtinchalik-1');
    assert.equal(tempLogin.status, 200);
    assert.equal(tempLogin.body.user.mustChangePassword, true);
    const cookie = sessionCookie(tempLogin);
    // /users/me is a business endpoint (NOT allowlisted) → gated until the password changes.
    for (const path of ['/api/v1/users/me', `/api/v1/users/${dirIds[1]}`, '/api/v1/users?limit=5']) {
      const res = await http('GET', path, { cookie });
      assert.equal(res.status, 403, `${path} must be gated`);
      assert.equal(res.body.error.code, 'PASSWORD_CHANGE_REQUIRED');
    }
  });

  // --------------------------- Template deletion ---------------------------

  /** Creates a DRAFT template with one step; returns { templateId, versionId }. */
  async function makeDraftTemplate(adminCookie: string, name: string): Promise<{ tId: number; vId: number }> {
    const created = await http('POST', '/api/v1/checklist-templates', { cookie: adminCookie, body: { name } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const tId = created.body.template.id as number;
    const vId = created.body.template.versions[0].id as number;
    const step = await http('POST', `/api/v1/checklist-templates/${tId}/versions/${vId}/steps`, {
      cookie: adminCookie,
      body: { name: 'Tekshiruv', measurements: [{ name: 'Bosim', unit: 'bar', minValue: 1, maxValue: 2, required: true }] },
    });
    assert.equal(step.status, 201);
    return { tId, vId };
  }

  await test('template list exposes deletable eligibility; an unused DRAFT template is deletable', async () => {
    const admin = sessionCookie(await login(PHONES.admin));
    const { tId } = await makeDraftTemplate(admin, 'TEST AW Draft Deletable');
    const list = await http('GET', '/api/v1/checklist-templates', { cookie: admin });
    const t = list.body.templates.find((x: any) => x.id === tId);
    assert.equal(t.deletable, true, 'a draft-only template is deletable');
    assert.equal(t.deletableReason, null);
  });

  await test('permanently delete an UNUSED draft-only template (cascades versions/steps/measurements, audited)', async () => {
    const admin = sessionCookie(await login(PHONES.admin));
    const { tId, vId } = await makeDraftTemplate(admin, 'TEST AW Draft ToDelete');
    const stepIds = (await db('checklist_steps').where({ version_id: vId }).select('id')).map((s: { id: number }) => s.id);
    assert.ok(stepIds.length > 0);

    const del = await http('DELETE', `/api/v1/checklist-templates/${tId}`, { cookie: admin });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.equal(del.body.deleted.id, tId);

    // Template + all children are gone.
    assert.equal(await db('checklist_templates').where({ id: tId }).first(), undefined, 'template row deleted');
    assert.equal(await db('checklist_template_versions').where({ id: vId }).first(), undefined, 'version deleted');
    assert.equal(Number((await db('checklist_steps').whereIn('id', stepIds).count({ c: '*' }).first())?.c ?? -1), 0, 'steps deleted');
    assert.equal(
      Number((await db('checklist_step_measurements').whereIn('step_id', stepIds).count({ c: '*' }).first())?.c ?? -1),
      0,
      'measurements cascaded',
    );

    // Audit recorded — with name + version count, NOT step internals.
    const audit = await db('audit_logs')
      .where({ action: 'TEMPLATE_DELETED', entity_type: 'checklist_template', entity_id: String(tId) })
      .first();
    assert.ok(audit, 'TEMPLATE_DELETED audit exists');
    assert.equal(Number(audit.user_id), ids.admin);
    const serialized = JSON.stringify(audit);
    assert.ok(serialized.includes('TEST AW Draft ToDelete'), 'audit records the template name');
    assert.ok(!/Tekshiruv|Bosim/.test(serialized), 'audit does not leak step/measurement internals');
  });

  await test('a non-admin cannot delete a template (403); unauthenticated is 401', async () => {
    const admin = sessionCookie(await login(PHONES.admin));
    const { tId } = await makeDraftTemplate(admin, 'TEST AW Draft Guarded');
    const rahbar = sessionCookie(await login(PHONES.rahbar)); // RAHBAR has no templates.manage
    assert.equal((await http('DELETE', `/api/v1/checklist-templates/${tId}`, { cookie: rahbar })).status, 403);
    assert.equal((await http('DELETE', `/api/v1/checklist-templates/${tId}`)).status, 401);
    assert.ok(await db('checklist_templates').where({ id: tId }).first(), 'template survives an unauthorized delete');
  });

  await test('a PUBLISHED (history-bearing) template cannot be permanently deleted; archived history is preserved', async () => {
    const admin = sessionCookie(await login(PHONES.admin));
    const { tId, vId } = await makeDraftTemplate(admin, 'TEST AW Published');
    const pub = await http('POST', `/api/v1/checklist-templates/${tId}/versions/${vId}/publish`, { cookie: admin });
    assert.equal(pub.status, 200, JSON.stringify(pub.body));

    // Not deletable now.
    const list = await http('GET', '/api/v1/checklist-templates', { cookie: admin });
    const t = list.body.templates.find((x: any) => x.id === tId);
    assert.equal(t.deletable, false);
    assert.equal(t.deletableReason, 'HAS_PUBLISHED_OR_ARCHIVED_HISTORY');

    const del = await http('DELETE', `/api/v1/checklist-templates/${tId}`, { cookie: admin });
    assert.equal(del.status, 409, JSON.stringify(del.body));
    assert.equal(del.body.error.code, 'TEMPLATE_HAS_HISTORY');
    assert.ok(await db('checklist_template_versions').where({ id: vId }).first(), 'the published version is preserved');

    // Archiving the version keeps it history — still not deletable, still present.
    const arch = await http('POST', `/api/v1/checklist-templates/${tId}/versions/${vId}/archive`, { cookie: admin });
    assert.equal(arch.status, 200);
    const del2 = await http('DELETE', `/api/v1/checklist-templates/${tId}`, { cookie: admin });
    assert.equal(del2.status, 409);
    assert.equal(del2.body.error.code, 'TEMPLATE_HAS_HISTORY');
    const archived = await db('checklist_template_versions').where({ id: vId }).first();
    assert.equal(archived.status, 'ARCHIVED', 'archived version remains available (not destroyed)');
  });

  /** Asserts the template is either FULLY present or FULLY gone — never a partial/orphan state. */
  async function assertNoOrphans(tId: number, vId: number, stepIds: number[]): Promise<'gone' | 'present'> {
    const tpl = await db('checklist_templates').where({ id: tId }).first();
    const vers = await db('checklist_template_versions').where({ template_id: tId });
    const steps = Number((await db('checklist_steps').whereIn('id', stepIds.length ? stepIds : [-1]).count({ c: '*' }).first())?.c ?? 0);
    const meas = Number(
      (await db('checklist_step_measurements').whereIn('step_id', stepIds.length ? stepIds : [-1]).count({ c: '*' }).first())?.c ?? 0,
    );
    if (!tpl) {
      // Fully gone: no versions, steps, or measurements linger.
      assert.equal(vers.length, 0, 'no orphan versions after delete');
      assert.equal(steps, 0, 'no orphan steps after delete');
      assert.equal(meas, 0, 'no orphan measurements after delete');
      return 'gone';
    }
    // Fully present: the version + its steps are intact.
    assert.ok(vers.some((v: any) => v.id === vId), 'the version is preserved');
    assert.equal(steps, stepIds.length, 'all steps preserved');
    return 'present';
  }

  await test('concurrent delete vs publish (x5): exactly one wins, no orphan/500/deadlock leak', async () => {
    const admin = sessionCookie(await login(PHONES.admin));
    for (let i = 0; i < 5; i++) {
      const { tId, vId } = await makeDraftTemplate(admin, `TEST AW RacePub ${i}`);
      const stepIds = (await db('checklist_steps').where({ version_id: vId }).select('id')).map((s: { id: number }) => s.id);
      const [del, pub] = await Promise.all([
        http('DELETE', `/api/v1/checklist-templates/${tId}`, { cookie: admin }),
        http('POST', `/api/v1/checklist-templates/${tId}/versions/${vId}/publish`, { cookie: admin }),
      ]);
      // No raw 500 from either operation (a deadlock maps to a stable 409, not a 500).
      assert.notEqual(del.status, 500, `delete must never 500 (got ${del.status} ${JSON.stringify(del.body)})`);
      assert.notEqual(pub.status, 500, `publish must never 500 (got ${pub.status} ${JSON.stringify(pub.body)})`);
      const state = await assertNoOrphans(tId, vId, stepIds);
      if (del.status === 200) {
        assert.equal(state, 'gone', 'delete won → template fully gone');
        assert.ok([404, 409].includes(pub.status), `publish fails cleanly when the template is gone (got ${pub.status})`);
      } else {
        // Publish won (or a retryable conflict) → template kept; delete refused as history/conflict.
        assert.ok([409].includes(del.status), `delete refused with a stable conflict (got ${del.status})`);
        assert.equal(state, 'present', 'template preserved');
        if (pub.status === 200) {
          const v = await db('checklist_template_versions').where({ id: vId }).first();
          assert.equal(v.status, 'PUBLISHED');
          assert.equal(del.body.error.code, 'TEMPLATE_HAS_HISTORY');
        }
      }
      // Clean up the survivor (if any) so the loop stays isolated.
      await db('checklist_step_measurements').whereIn('step_id', stepIds.length ? stepIds : [-1]).del();
      await db('checklist_steps').where({ version_id: vId }).del();
      await db('checklist_template_versions').where({ template_id: tId }).del();
      await db('checklist_templates').where({ id: tId }).del();
    }
  });

  await test('concurrent delete vs draft mutation (addStep, x5): no orphan/500, clean outcome', async () => {
    const admin = sessionCookie(await login(PHONES.admin));
    for (let i = 0; i < 5; i++) {
      const { tId, vId } = await makeDraftTemplate(admin, `TEST AW RaceStep ${i}`);
      const [del, add] = await Promise.all([
        http('DELETE', `/api/v1/checklist-templates/${tId}`, { cookie: admin }),
        http('POST', `/api/v1/checklist-templates/${tId}/versions/${vId}/steps`, { cookie: admin, body: { name: 'Qoshimcha' } }),
      ]);
      assert.notEqual(del.status, 500, `delete must never 500 (got ${del.status})`);
      assert.notEqual(add.status, 500, `addStep must never 500 (got ${add.status})`);
      const tpl = await db('checklist_templates').where({ id: tId }).first();
      if (del.status === 200) {
        // Delete won → template + all steps gone; a step added after commit is impossible.
        assert.equal(tpl, undefined, 'template fully deleted');
        assert.equal((await db('checklist_template_versions').where({ template_id: tId })).length, 0, 'no orphan versions');
        assert.equal(Number((await db('checklist_steps').where({ version_id: vId }).count({ c: '*' }).first())?.c ?? 0), 0, 'no orphan steps');
        // addStep may have committed (201) just before delete removed the version+step,
        // or failed cleanly once the version was gone (404) / conflicted (409).
        assert.ok([201, 404, 409].includes(add.status), `addStep resolves cleanly (got ${add.status})`);
      } else {
        // addStep won the row → the draft (with the extra step) survives; delete was a clean conflict/retry.
        assert.ok([409].includes(del.status), `delete refused/retry (got ${del.status})`);
        assert.ok(tpl, 'template preserved when delete did not win');
      }
      await db('checklist_steps').where({ version_id: vId }).del();
      await db('checklist_template_versions').where({ template_id: tId }).del();
      await db('checklist_templates').where({ id: tId }).del();
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
