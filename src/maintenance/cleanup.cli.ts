/**
 * Phase 10C maintenance CLI.
 *
 *   npm run cleanup              # dry-run: counts only, no changes
 *   npm run cleanup -- --apply   # delete/recover eligible records (bounded batches)
 *   npm run cleanup -- --json    # machine-readable
 *
 * Safe across simultaneous invocations (MySQL advisory lock), idempotent, and
 * never prints credentials or tokens. Prefer running this as an external cron
 * job rather than an in-process timer (see docs/PRODUCTION-RUNTIME-10C.md).
 * Exit codes: 0 = ok; 1 = operational failure.
 */
import { db } from '../config/database';
import { runCleanup } from './cleanup.service';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const json = args.includes('--json');

  const result = await runCleanup({ apply });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[cleanup] mode: ${result.dryRun ? 'DRY-RUN (no changes)' : 'APPLY'}`);
    for (const c of result.categories) {
      const extra = c.note ? `  (${c.note})` : '';
      console.log(`  ${c.category.padEnd(24)} eligible=${c.eligible} affected=${c.affected}${extra}`);
    }
  }

  await db.destroy();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('[cleanup] failed:', err instanceof Error ? err.message : err);
  try {
    await db.destroy();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
