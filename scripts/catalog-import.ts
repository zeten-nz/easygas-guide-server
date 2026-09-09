/**
 * Catalogue import CLI (Phase 11B §9).
 *
 *   npm run catalog:import -- <source-file> [--format json|html] [--apply] [--actor <id>]
 *
 * DRY-RUN by default: prints what WOULD change and writes nothing. `--apply`
 * performs an INSERT-ONLY, idempotent import in one transaction — it never
 * overwrites existing rows (manual edits are preserved) and never duplicates.
 *
 * SAFETY: `--apply` is refused unless the target database name ends with
 * "_test" (fail-closed) — this task only ever imports into the isolated test
 * database, never the business database. The source file is parsed as DATA; its
 * embedded scripts are never executed.
 */
import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const file = argv.find((a) => !a.startsWith('--'));
  const apply = argv.includes('--apply');
  const formatArg = argv.includes('--format') ? (argv[argv.indexOf('--format') + 1] as 'json' | 'html') : undefined;
  const actorArg = argv.includes('--actor') ? Number(argv[argv.indexOf('--actor') + 1]) : undefined;

  if (!file) {
    console.error('Usage: catalog-import <source-file> [--format json|html] [--apply] [--actor <id>]');
    process.exit(2);
  }
  const abs = path.resolve(process.cwd(), file);
  if (!fs.existsSync(abs)) {
    console.error(`Source file not found: ${abs}`);
    process.exit(2);
  }
  const format: 'json' | 'html' = formatArg ?? (abs.toLowerCase().endsWith('.html') ? 'html' : 'json');

  // Load DB only after argv validation so --help style misuse never connects.
  const { db } = await import('../src/config/database');
  const importSvc = await import('../src/modules/catalog/import/import.service');

  const dbName = process.env.DB_NAME ?? '';
  if (apply && !/_test$/.test(dbName)) {
    console.error(
      `Refusing to --apply against "${dbName}": this task only imports into a *_test database. ` +
        `Set DB_NAME to the test database (e.g. easygas_test) to apply.`,
    );
    await db.destroy();
    process.exit(3);
  }

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
  if (apply && actorId === undefined) {
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

  const report = apply ? await importSvc.applyImport(source, actorId!, db) : await importSvc.planImport(source, db);

  console.log(`\n=== Catalogue import ${apply ? 'APPLIED' : 'DRY-RUN (no writes)'} — DB: ${dbName} ===`);
  console.log(
    `Products: total ${report.products.total}, ${apply ? 'inserted' : 'to insert'} ${report.products.toInsert}, existing (skipped) ${report.products.existing}, invalid ${report.products.invalid}`,
  );
  console.log(
    `Services: total ${report.services.total}, ${apply ? 'inserted' : 'to insert'} ${report.services.toInsert}, existing (skipped) ${report.services.existing}, invalid ${report.services.invalid}`,
  );
  const r = report.referencesToCreate;
  console.log(
    `References ${apply ? 'created' : 'to create'}: companies ${r.companies.length}, brands ${r.brands.length}, product-categories ${r.productCategories.length}, service-categories ${r.serviceCategories.length}, units ${r.units.length}`,
  );
  if (report.issues.length > 0) {
    console.log(`\nIssues (${report.issues.length}) — reported, NOT silently corrected:`);
    for (const i of report.issues.slice(0, 50)) console.log(`  [${i.kind} #${i.index} code=${i.code ?? '—'}] ${i.reason}`);
    if (report.issues.length > 50) console.log(`  … and ${report.issues.length - 50} more`);
  }
  if (apply && report.inserted) {
    console.log(`\nApplied in ONE transaction: +${report.inserted.products} products, +${report.inserted.services} services, +${report.inserted.references} references.`);
  } else if (!apply) {
    console.log('\nRe-run with --apply (against a *_test DB) to write these changes.');
  }

  await db.destroy();
}

main().catch((err) => {
  console.error('[catalog-import] Failed:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
