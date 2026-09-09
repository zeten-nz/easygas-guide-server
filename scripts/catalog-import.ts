/**
 * Catalogue import CLI (Phase 11B §9).
 *
 *   npm run catalog:import -- <source-file> [--format json|html] [--apply] [--actor <id>]
 *
 * DRY-RUN by default: prints what WOULD change and writes nothing. Two apply modes,
 * both INSERT-ONLY, idempotent and transactional (never overwrites existing rows,
 * never duplicates), both fail-closed and both refusing production:
 *   --apply                          → the isolated *_test database only.
 *   --local-apply --confirm-db <name>→ an explicit LOCAL DEVELOPMENT database (local
 *                                      host, non-production, name = --confirm-db).
 * The source file is parsed as DATA; its embedded scripts are never executed.
 */
import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { resolveImportTarget } from '../src/modules/catalog/import/import-target';

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const file = argv.find((a) => !a.startsWith('--'));
  const apply = argv.includes('--apply');
  const localApply = argv.includes('--local-apply');
  const confirmDb = argv.includes('--confirm-db') ? argv[argv.indexOf('--confirm-db') + 1] : undefined;
  const formatArg = argv.includes('--format') ? (argv[argv.indexOf('--format') + 1] as 'json' | 'html') : undefined;
  const actorArg = argv.includes('--actor') ? Number(argv[argv.indexOf('--actor') + 1]) : undefined;

  if (!file) {
    console.error('Usage: catalog-import <source-file> [--format json|html] [--apply | --local-apply --confirm-db <name>] [--actor <id>]');
    process.exit(2);
  }
  const abs = path.resolve(process.cwd(), file);
  if (!fs.existsSync(abs)) {
    console.error(`Source file not found: ${abs}`);
    process.exit(2);
  }
  const format: 'json' | 'html' = formatArg ?? (abs.toLowerCase().endsWith('.html') ? 'html' : 'json');

  const dbName = process.env.DB_NAME ?? '';
  // Decide the write target BEFORE connecting — fail-closed, production always refused.
  const decision = resolveImportTarget(
    { apply, localApply, confirmDb },
    { dbName, dbHost: process.env.DB_HOST ?? '127.0.0.1', nodeEnv: process.env.NODE_ENV ?? 'development' },
  );
  if (!decision.ok) {
    console.error(`Refusing to write: ${decision.reason}`);
    process.exit(3);
  }
  const willWrite = decision.mode !== 'DRY_RUN';

  // Load DB only after argv/target validation so --help style misuse never connects.
  const { db } = await import('../src/config/database');
  const importSvc = await import('../src/modules/catalog/import/import.service');

  const text = fs.readFileSync(abs, 'utf8');
  let source;
  try {
    source = importSvc.parseSource(text, format);
  } catch (err) {
    console.error(`Failed to PARSE source (as data — never executed): ${err instanceof Error ? err.message : err}`);
    await db.destroy();
    process.exit(2);
  }

  let actorId = actorArg;
  if (willWrite && actorId === undefined) {
    const admin = (await db('users').join('roles', 'roles.id', 'users.role_id').where('roles.code', 'ADMIN').select('users.id').first()) as
      | { id: number }
      | undefined;
    if (!admin) {
      console.error('No ADMIN user found to attribute the import to; pass --actor <id>.');
      await db.destroy();
      process.exit(3);
    }
    actorId = admin.id;
  }

  const report = willWrite ? await importSvc.applyImport(source, actorId!, db) : await importSvc.planImport(source, db);

  const modeLabel = decision.mode === 'TEST_APPLY' ? 'APPLIED (test DB)' : decision.mode === 'LOCAL_APPLY' ? 'APPLIED (local dev DB)' : 'DRY-RUN (no writes)';
  console.log(`\n=== Catalogue import ${modeLabel} — DB: ${dbName} ===`);
  console.log(
    `Products: total ${report.products.total}, ${willWrite ? 'inserted' : 'to insert'} ${report.products.toInsert}, existing (skipped) ${report.products.existing}, invalid ${report.products.invalid}`,
  );
  console.log(
    `Services: total ${report.services.total}, ${willWrite ? 'inserted' : 'to insert'} ${report.services.toInsert}, existing (skipped) ${report.services.existing}, invalid ${report.services.invalid}`,
  );
  const r = report.referencesToCreate;
  console.log(
    `References ${willWrite ? 'created' : 'to create'}: companies ${r.companies.length}, brands ${r.brands.length}, product-categories ${r.productCategories.length}, service-categories ${r.serviceCategories.length}, units ${r.units.length}`,
  );
  if (report.issues.length > 0) {
    console.log(`\nIssues (${report.issues.length}) — reported, NOT silently corrected:`);
    for (const i of report.issues.slice(0, 50)) console.log(`  [${i.kind} #${i.index} code=${i.code ?? '—'}] ${i.reason}`);
    if (report.issues.length > 50) console.log(`  … and ${report.issues.length - 50} more`);
  }
  if (willWrite && report.inserted) {
    console.log(`\nApplied in ONE transaction: +${report.inserted.products} products, +${report.inserted.services} services, +${report.inserted.references} references.`);
  } else if (!willWrite) {
    console.log('\nRe-run with --apply (*_test DB) or --local-apply --confirm-db <name> (local dev DB) to write these changes.');
  }

  await db.destroy();
}

main().catch((err) => {
  console.error('[catalog-import] Failed:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
