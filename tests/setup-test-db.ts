/**
 * One-command isolated test-database setup (Phase 10A):
 *
 *   npm run test:setup
 *
 * Creates the *_test database if missing (name chosen by tests/helpers/
 * test-env.ts — TEST_DB_NAME → "<DB_NAME>_test" → "easygas_test"), then runs
 * all migrations and seeds against it. Credentials are never printed. Safe for
 * CI: the bootstrap fails closed unless the target name ends with "_test".
 */
import './helpers/test-env'; // must be first — pins NODE_ENV=test + test DB name
import path from 'node:path';
import mysql from 'mysql2/promise';
// CJS requires execute in order: this loads AFTER the env is pinned above.
import { db } from '../src/config/database';

async function main() {
  const dbName = process.env.DB_NAME!;
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD ?? '',
  });
  await connection.query(
    `CREATE DATABASE IF NOT EXISTS \`${dbName.replace(/[^A-Za-z0-9_]/g, '')}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await connection.end();
  console.log(`[test-setup] Database ready: ${dbName}`);

  const migrateConfig = { directory: path.resolve(__dirname, '../migrations'), loadExtensions: ['.ts'] };
  const [, migrations] = (await db.migrate.latest(migrateConfig)) as [number, string[]];
  console.log(`[test-setup] Migrations applied now: ${migrations.length}`);
  await db.seed.run({ directory: path.resolve(__dirname, '../seeds'), loadExtensions: ['.ts'] });
  console.log('[test-setup] Seeds applied');

  // Phase 10D: activate the provisional v1 risk matrix for deterministic tests
  // (a test-only bootstrap — production requires an explicit authorized approval
  // via the API or the risk-policy CLI). Idempotent.
  const active = await db('risk_matrix_versions').where({ status: 'ACTIVE' }).first();
  if (!active) {
    const approver = await db('users').join('roles', 'roles.id', 'users.role_id').where('roles.code', 'ADMIN').select('users.id').first();
    const target = await db('risk_matrix_versions').where({ version: 'v1' }).first();
    if (approver && target) {
      await db('risk_matrix_versions').where({ status: 'ACTIVE' }).update({ status: 'RETIRED' });
      await db('risk_matrix_versions').where({ id: target.id }).update({
        status: 'ACTIVE',
        approved_by: approver.id,
        approved_at: db.raw('CURRENT_TIMESTAMP(6)'),
        rationale: 'TEST BOOTSTRAP — provisional v1 activated for deterministic tests',
      });
      console.log('[test-setup] Risk matrix v1 activated (test bootstrap)');
    }
  }
  await db.destroy();
}

main().catch((err) => {
  console.error('[test-setup] Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
