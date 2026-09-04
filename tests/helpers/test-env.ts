/**
 * Fail-closed test-environment bootstrap (Phase 10A).
 *
 * MUST be the FIRST import of every E2E suite — it runs before
 * src/config/env.ts is loaded and redirects the process to the isolated test
 * database. The guards fail closed: destructive cleanup can only ever run
 * with NODE_ENV=test against a database whose name ends in "_test".
 *
 * Selection order: TEST_DB_NAME → "<DB_NAME>_test" → "easygas_test".
 * One-command setup: `npm run test:setup` (creates the DB, migrates, seeds).
 */
process.env.NODE_ENV = 'test';

const baseName = process.env.DB_NAME?.trim();
const testDbName =
  process.env.TEST_DB_NAME?.trim() || (baseName && !baseName.endsWith('_test') ? `${baseName}_test` : baseName) || 'easygas_test';

if (!/_test$/.test(testDbName)) {
  // eslint-disable-next-line no-console
  console.error(
    `[test-env] REFUSING to run: test database name "${testDbName}" does not end with "_test". ` +
      'Set TEST_DB_NAME to a dedicated test database.',
  );
  process.exit(1);
}

process.env.DB_NAME = testDbName;
// eslint-disable-next-line no-console
console.log(`[test-env] NODE_ENV=test, test database: ${testDbName}`);

/**
 * Second, independent fail-closed guard — call before ANY destructive cleanup.
 * Verifies the LIVE connection really points at a *_test schema, so even a
 * mis-ordered import or stray configuration cannot wipe a real database.
 */
export async function assertTestDatabase(db: { raw: (sql: string) => Promise<unknown> }): Promise<void> {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('[test-env] Destructive test cleanup refused: NODE_ENV is not "test"');
  }
  const result = (await db.raw('SELECT DATABASE() AS db')) as [{ db: string | null }[], unknown];
  const connected = result[0]?.[0]?.db;
  if (!connected || !/_test$/.test(connected)) {
    throw new Error(
      `[test-env] Destructive test cleanup refused: connected database "${connected}" is not a *_test database`,
    );
  }
}
