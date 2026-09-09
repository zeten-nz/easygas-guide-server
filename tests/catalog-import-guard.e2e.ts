/**
 * EASY GAS — Phase 11C catalogue-import target guard (pure; no DB).
 *
 *   npm run test:import-guard
 *
 * Verifies the fail-closed decision for `--apply` (test DB only) and `--local-apply`
 * (explicit local dev DB), and that BOTH refuse production and every wrong target.
 */
import assert from 'node:assert/strict';
import { resolveImportTarget } from '../src/modules/catalog/import/import-target';

const DEV = { dbName: 'easygas', dbHost: '127.0.0.1', nodeEnv: 'development' };
const TEST = { dbName: 'easygas_test', dbHost: '127.0.0.1', nodeEnv: 'test' };
const PROD = { dbName: 'easygas', dbHost: '10.0.0.5', nodeEnv: 'production' };
const REMOTE = { dbName: 'easygas', dbHost: 'db.internal.example.com', nodeEnv: 'development' };

let passed = 0, failed = 0;
function t(name: string, fn: () => void) { try { fn(); passed++; console.log(`  PASS  ${name}`); } catch (e) { failed++; console.error(`  FAIL  ${name}\n        ${e instanceof Error ? e.message : e}`); } }

// Defaults / dry-run
t('no flags → DRY_RUN', () => { const d = resolveImportTarget({ apply: false, localApply: false }, DEV); assert.equal(d.ok, true); assert.equal(d.mode, 'DRY_RUN'); });

// --apply (test-only, unchanged)
t('--apply on *_test → TEST_APPLY', () => { const d = resolveImportTarget({ apply: true, localApply: false }, TEST); assert.equal(d.ok, true); assert.equal(d.mode, 'TEST_APPLY'); });
t('--apply on a NON-_test (dev) DB is refused', () => { const d = resolveImportTarget({ apply: true, localApply: false }, DEV); assert.equal(d.ok, false); });
t('--apply in production is refused (even if named *_test)', () => { const d = resolveImportTarget({ apply: true, localApply: false }, { dbName: 'easygas_test', dbHost: '10.0.0.5', nodeEnv: 'production' }); assert.equal(d.ok, false); });

// --local-apply (explicit local dev)
t('--local-apply local dev + matching --confirm-db → LOCAL_APPLY', () => { const d = resolveImportTarget({ apply: false, localApply: true, confirmDb: 'easygas' }, DEV); assert.equal(d.ok, true); assert.equal(d.mode, 'LOCAL_APPLY'); });
t('--local-apply WITHOUT --confirm-db is refused', () => { const d = resolveImportTarget({ apply: false, localApply: true }, DEV); assert.equal(d.ok, false); });
t('--local-apply with MISMATCHED --confirm-db is refused', () => { const d = resolveImportTarget({ apply: false, localApply: true, confirmDb: 'wrong' }, DEV); assert.equal(d.ok, false); });
t('--local-apply against a REMOTE host is refused', () => { const d = resolveImportTarget({ apply: false, localApply: true, confirmDb: 'easygas' }, REMOTE); assert.equal(d.ok, false); });
t('--local-apply against a *_test DB is refused (use --apply)', () => { const d = resolveImportTarget({ apply: false, localApply: true, confirmDb: 'easygas_test' }, TEST); assert.equal(d.ok, false); });
t('--local-apply in production is refused (no rename/env trick)', () => { const d = resolveImportTarget({ apply: false, localApply: true, confirmDb: 'easygas' }, PROD); assert.equal(d.ok, false); });

// Both flags
t('--apply + --local-apply together is refused', () => { const d = resolveImportTarget({ apply: true, localApply: true, confirmDb: 'easygas' }, DEV); assert.equal(d.ok, false); });

console.log(`\ncatalog-import-guard: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
