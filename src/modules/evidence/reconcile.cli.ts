/**
 * Evidence reconciliation CLI (Phase 10B).
 *
 *   npm run reconcile                       # dry-run: report only, no changes
 *   npm run reconcile -- --deep             # dry-run, full sha256 re-hash of READY rows
 *   npm run reconcile -- --apply            # apply transitions (alias: --fix)
 *   npm run reconcile -- --apply --deep     # apply, with full-hash READY verification
 *   npm run reconcile -- --concurrency=8    # bound parallel object reads (default 4)
 *   npm run reconcile -- --json             # machine-readable output
 *
 * Legacy UNVERIFIED rows are ALWAYS deep-verified (their bytes are read and
 * hashed) and only promoted to READY on a full match; otherwise they become
 * FAILED. Never deletes storage objects. Output and audit records never contain
 * storage keys or paths.
 *
 * Exit codes: 0 = clean; 2 = invalid or unverifiable evidence remains (missing,
 * mismatched, stale, or a transient error) — in dry-run these are unaddressed,
 * in apply mode they have been recorded as FAILED (or left for retry) and need
 * operator attention before active jobs rely on them; 1 = the run itself failed.
 */
import { db } from '../../config/database';
import { reconcileEvidence } from './reconcile.service';

function parseConcurrency(args: string[]): number | undefined {
  const a = args.find((x) => x.startsWith('--concurrency='));
  if (!a) return undefined;
  const n = Number(a.split('=')[1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply') || args.includes('--fix');
  const deep = args.includes('--deep');
  const json = args.includes('--json');
  const concurrency = parseConcurrency(args);

  const result = await reconcileEvidence({ apply, deep, concurrency });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[reconcile] mode: ${result.dryRun ? 'DRY-RUN (no changes)' : 'APPLY'}${result.deep ? ' + DEEP' : ''}`);
    console.log(
      `[reconcile] scanned: ${result.scanned}, verified: ${result.verified}, failed: ${result.failed}, ` +
        `unresolved: ${result.unresolved}`,
    );
    for (const r of result.findings) {
      const did = r.transitionedTo ? ` -> ${r.transitionedTo}` : '';
      console.log(`  ${r.kind.padEnd(8)} ${r.table} #${r.id} (job ${r.jobId}) — ${r.reason}${did}`);
    }
    if (result.findings.length === 0) console.log('[reconcile] no integrity problems found');
  }

  await db.destroy();
  // Non-zero when invalid/unverifiable evidence remains, so operators/CI notice.
  process.exit(result.unresolved > 0 ? 2 : 0);
}

main().catch((err) => {
  console.error('[reconcile] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
