import bcrypt from 'bcrypt';
import type { Knex } from 'knex';

/**
 * DEVELOPMENT-ONLY demo accounts — one active user per business role so every
 * role can be tested manually. Refuses to run when NODE_ENV=production.
 *
 * Credentials are intentionally fake and documented in PROJECT_STATUS.md
 * ("Development Demo Accounts"). Idempotent: re-running the seed never creates
 * duplicates; it only re-syncs accounts it positively identifies as demo
 * accounts (reserved demo phone + first name "Demo"). Real users are never
 * touched or deleted.
 */

const DEMO_PASSWORD = 'EasyGasDev2026!';

const DEMO_USERS: { phone: string; roleCode: string; lastName: string; branch: 'first-active' | null }[] = [
  { phone: '+998901000001', roleCode: 'USTA', lastName: 'Usta', branch: 'first-active' },
  { phone: '+998901000002', roleCode: 'MASTER', lastName: 'Master', branch: 'first-active' },
  { phone: '+998901000003', roleCode: 'RAHBAR', lastName: 'Rahbar', branch: 'first-active' },
  { phone: '+998901000004', roleCode: 'SIFAT', lastName: 'Sifat', branch: 'first-active' },
  // ADMIN follows the existing admin convention: cross-branch (branch_id NULL).
  { phone: '+998901000005', roleCode: 'ADMIN', lastName: 'Admin', branch: null },
];

export async function seed(knex: Knex): Promise<void> {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  if (nodeEnv === 'production') {
    // eslint-disable-next-line no-console
    console.warn('[seed] NODE_ENV=production — demo users seed skipped (development-only)');
    return;
  }

  const roles = await knex('roles').select('id', 'code');
  const roleIdByCode = new Map<string, number>(roles.map((r: { code: string; id: number }) => [r.code, r.id]));

  const firstActiveBranch = await knex('branches').where({ status: 'ACTIVE' }).orderBy('id').first();
  if (!firstActiveBranch) {
    throw new Error('[seed] No ACTIVE branch found — run the branches seed first');
  }

  const rounds = Number(process.env.BCRYPT_ROUNDS ?? 12);

  for (const demo of DEMO_USERS) {
    const roleId = roleIdByCode.get(demo.roleCode);
    if (!roleId) {
      throw new Error(`[seed] Role ${demo.roleCode} not found — run the roles seed first`);
    }
    const branchId = demo.branch === 'first-active' ? firstActiveBranch.id : null;

    // Look up by phone including soft-deleted rows (phone is globally unique).
    const existing = await knex('users').where({ phone: demo.phone }).first();

    if (!existing) {
      await knex('users').insert({
        first_name: 'Demo',
        last_name: demo.lastName,
        phone: demo.phone,
        password_hash: await bcrypt.hash(DEMO_PASSWORD, rounds),
        region: 'Toshkent shahri',
        branch_id: branchId,
        role_id: roleId,
        status: 'ACTIVE',
      });
      // eslint-disable-next-line no-console
      console.log(`[seed] Demo user created: ${demo.phone} (${demo.roleCode})`);
      continue;
    }

    // Safety: only accounts that look like demo accounts are ever modified.
    // If a real user somehow occupies a reserved demo phone, leave it alone.
    if (existing.first_name !== 'Demo') {
      // eslint-disable-next-line no-console
      console.warn(
        `[seed] ${demo.phone} exists but is not a demo account (first_name=${existing.first_name}) — skipped`,
      );
      continue;
    }

    // Re-sync the demo account to a known-good development state.
    const update: Record<string, unknown> = {};
    if (existing.last_name !== demo.lastName) update.last_name = demo.lastName;
    if (existing.role_id !== roleId) update.role_id = roleId;
    if (existing.branch_id !== branchId) update.branch_id = branchId;
    if (existing.status !== 'ACTIVE') update.status = 'ACTIVE';
    if (existing.deleted_at !== null) update.deleted_at = null;
    if (!(await bcrypt.compare(DEMO_PASSWORD, existing.password_hash))) {
      update.password_hash = await bcrypt.hash(DEMO_PASSWORD, rounds);
    }

    if (Object.keys(update).length > 0) {
      update.updated_at = knex.fn.now();
      await knex('users').where({ id: existing.id }).update(update);
      // eslint-disable-next-line no-console
      console.log(`[seed] Demo user re-synced: ${demo.phone} (${demo.roleCode})`);
    } else {
      // eslint-disable-next-line no-console
      console.log(`[seed] Demo user up to date: ${demo.phone} (${demo.roleCode})`);
    }
  }
}
