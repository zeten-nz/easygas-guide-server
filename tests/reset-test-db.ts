/**
 * Phase 10F — pristine isolated test DB for the browser E2E harness.
 *   npm run test:e2e:reset
 *
 * DROPS and recreates the *_test database, then migrates + seeds + activates the
 * provisional v1 risk matrix — so every full-stack Playwright run starts from an
 * identical clean fixture set (no leakage across runs). Fail-closed: refuses to
 * touch any database whose name does not end in "_test" (double-guarded on top of
 * tests/helpers/test-env.ts). Never affects developer/production data.
 */
import './helpers/test-env'; // first — pins NODE_ENV=test + the *_test DB name
import path from 'node:path';
import mysql from 'mysql2/promise';
import { db } from '../src/config/database';

async function main() {
  const dbName = process.env.DB_NAME!;
  if (process.env.NODE_ENV !== 'test' || !/_test$/.test(dbName)) {
    throw new Error(`[test-reset] refusing to reset non-test database "${dbName}"`);
  }
  const safe = dbName.replace(/[^A-Za-z0-9_]/g, '');
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD ?? '',
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${safe}\``);
  await admin.query(`CREATE DATABASE \`${safe}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await admin.end();
  console.log(`[test-reset] Recreated pristine ${dbName}`);

  const migrateConfig = { directory: path.resolve(__dirname, '../migrations'), loadExtensions: ['.ts'] };
  const [, migrations] = (await db.migrate.latest(migrateConfig)) as [number, string[]];
  console.log(`[test-reset] Migrations applied: ${migrations.length}`);
  await db.seed.run({ directory: path.resolve(__dirname, '../seeds'), loadExtensions: ['.ts'] });

  const approver = await db('users').join('roles', 'roles.id', 'users.role_id').where('roles.code', 'ADMIN').select('users.id').first();
  const target = await db('risk_matrix_versions').where({ version: 'v1' }).first();
  if (approver && target) {
    await db('risk_matrix_versions').where({ status: 'ACTIVE' }).update({ status: 'RETIRED' });
    await db('risk_matrix_versions').where({ id: target.id }).update({
      status: 'ACTIVE',
      approved_by: approver.id,
      approved_at: db.raw('CURRENT_TIMESTAMP(6)'),
      rationale: 'TEST BOOTSTRAP — provisional v1 activated for deterministic E2E',
    });
  }
  console.log('[test-reset] Seeded + risk matrix v1 active');
  await db.destroy();
}

main().catch((err) => {
  console.error('[test-reset] Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
