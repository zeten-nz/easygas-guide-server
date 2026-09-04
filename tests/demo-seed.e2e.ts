/**
 * EASY GAS — development demo accounts verification.
 *
 * Prerequisite: migrations + seeds applied (npm run migrate && npm run seed).
 * Verifies that each demo account exists exactly once, can log in with the
 * documented development password, and receives the correct role, permissions
 * and branch assignment. Read-only: creates no data (only login sessions,
 * which it logs out again).
 *
 *   npm run test:demo-seed
 */
import assert from 'node:assert/strict';
import { db } from '../src/config/database';
import { createApp } from '../src/app';
import { ROLE_PERMISSIONS } from '../src/rbac/permissions';
import type { RoleCode } from '../src/types/auth';

const DEMO_PASSWORD = 'EasyGasDev2026!';

const EXPECTED: { phone: string; role: RoleCode; lastName: string; branchScoped: boolean }[] = [
  { phone: '+998901000001', role: 'USTA', lastName: 'Usta', branchScoped: true },
  { phone: '+998901000002', role: 'MASTER', lastName: 'Master', branchScoped: true },
  { phone: '+998901000003', role: 'RAHBAR', lastName: 'Rahbar', branchScoped: true },
  { phone: '+998901000004', role: 'SIFAT', lastName: 'Sifat', branchScoped: true },
  { phone: '+998901000005', role: 'ADMIN', lastName: 'Admin', branchScoped: false },
];

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

async function run(): Promise<void> {
  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  console.log(`\nVerifying demo accounts against ${baseUrl}\n`);

  const firstActiveBranch = await db('branches').where({ status: 'ACTIVE' }).orderBy('id').first();
  assert.ok(firstActiveBranch, 'an ACTIVE branch must exist');

  await test('each demo phone exists exactly once (idempotent seed)', async () => {
    for (const demo of EXPECTED) {
      const rows = await db('users').where({ phone: demo.phone });
      assert.equal(rows.length, 1, `${demo.phone}: expected exactly 1 user, found ${rows.length}`);
      assert.equal(rows[0].status, 'ACTIVE', `${demo.phone} must be ACTIVE`);
      assert.equal(rows[0].deleted_at, null, `${demo.phone} must not be soft-deleted`);
      assert.notEqual(rows[0].password_hash, DEMO_PASSWORD, 'password must be hashed, never plaintext');
      assert.ok(String(rows[0].password_hash).startsWith('$2'), 'password_hash must be a bcrypt hash');
    }
  });

  for (const demo of EXPECTED) {
    await test(`${demo.role} demo account logs in with correct role, permissions and branch`, async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: demo.phone, password: DEMO_PASSWORD, rememberMe: false }),
      });
      assert.equal(res.status, 200, `login failed for ${demo.phone}`);
      const body = (await res.json()) as any;

      assert.equal(body.user.role, demo.role);
      assert.equal(body.user.firstName, 'Demo');
      assert.equal(body.user.lastName, demo.lastName);
      assert.deepEqual(
        [...body.user.permissions].sort(),
        [...ROLE_PERMISSIONS[demo.role]].sort(),
        `permissions must match the RBAC registry for ${demo.role}`,
      );

      if (demo.branchScoped) {
        assert.equal(body.user.branchId, firstActiveBranch.id, `${demo.role} must be in the first active branch`);
      } else {
        assert.equal(body.user.branchId, null, 'demo ADMIN follows the cross-branch convention');
      }

      // Clean up the session created by this check.
      const cookie = res.headers
        .getSetCookie()
        .find((c) => c.startsWith('eg_session='))
        ?.split(';')[0];
      assert.ok(cookie, 'session cookie must be set');
      await fetch(`${baseUrl}/api/v1/auth/logout`, { method: 'POST', headers: { cookie } });
    });
  }

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
