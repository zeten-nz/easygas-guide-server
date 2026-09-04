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
  await db.destroy();
}

main().catch((err) => {
  console.error('[test-setup] Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
