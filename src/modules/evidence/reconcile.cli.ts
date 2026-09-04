/**
 * Evidence reconciliation CLI (Phase 10B):
 *
 *   npm run reconcile              # dry-run: report only, no changes
 *   npm run reconcile -- --fix     # mark missing/corrupt READY rows FAILED
 *   npm run reconcile -- --json    # machine-readable output
 *
 * Never deletes storage objects. --fix only transitions bad READY rows to
 * FAILED (so they stop counting toward completion) and stale PENDING rows to
 * FAILED, always auditing an EVIDENCE_INTEGRITY_FAILURE.
 */
import { db } from '../../config/database';
import { reconcileEvidence } from './reconcile.service';

async function main() {
  const args = process.argv.slice(2);
  const fix = args.includes('--fix');
  const json = args.includes('--json');

  const result = await reconcileEvidence({ fix });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[reconcile] mode: ${result.dryRun ? 'DRY-RUN (no changes)' : 'FIX'}`);
    console.log(`[reconcile] scanned: ${result.scanned}, findings: ${result.findings.length}, fixed: ${result.fixed}`);
    for (const f of result.findings) {
      console.log(`  ${f.kind.padEnd(8)} ${f.table} #${f.id} (job ${f.jobId}) — ${f.detail}`);
    }
    if (result.findings.length === 0) console.log('[reconcile] no integrity problems found');
  }

  await db.destroy();
  // Non-zero exit when problems remain unaddressed, so operators/CI notice.
  process.exit(result.findings.length > 0 && result.dryRun ? 2 : 0);
}

main().catch((err) => {
  console.error('[reconcile] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
