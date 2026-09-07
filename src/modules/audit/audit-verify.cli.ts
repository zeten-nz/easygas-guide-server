/**
 * Phase 10F — audit chain verification CLI.
 *
 *   npm run audit:verify              # read-only verification (exit 2 on failure)
 *   npm run audit:verify -- --json    # machine-readable output
 *   npm run audit:verify -- --checkpoint "nightly anchor"   # ALSO write export checkpoints
 *
 * Read-only by DEFAULT. Never repairs or deletes. Exit codes:
 *   0 = all chains verified   2 = integrity failure   1 = operational error
 *
 * NOTE (documented limitation): a database administrator who can rewrite BOTH the
 * rows AND their hashes/heads can produce a self-consistent forged chain. The
 * only defense is anchoring checkpoints OFF-SERVER (see --checkpoint and
 * server/docs/AUDIT-INTEGRITY-10F.md).
 */
import { db } from '../../config/database';
import { verifyAuditChains, writeCheckpoints } from './audit-verify';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const cpIdx = args.indexOf('--checkpoint');
  const doCheckpoint = cpIdx !== -1;
  const cpNote = doCheckpoint ? (args[cpIdx + 1] && !args[cpIdx + 1].startsWith('--') ? args[cpIdx + 1] : 'manual checkpoint') : '';

  const result = await verifyAuditChains();

  if (doCheckpoint && result.ok) {
    const n = await writeCheckpoints(cpNote);
    if (!json) console.log(`Wrote ${n} checkpoint(s): "${cpNote}"`);
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Audit chain verification: ${result.ok ? 'OK' : 'FAILED'}`);
    console.log(`  chains verified: ${result.chains.length}, chained entries: ${result.totalChained}, legacy/unchained: ${result.legacyUnchained}`);
    for (const c of result.chains) console.log(`  [${c.ok ? 'OK ' : 'BAD'}] ${c.chainId} (${c.entries} entries)${c.error ? ' — ' + c.error : ''}`);
    if (result.headMismatch.length) console.log(`  HEAD MISMATCH: ${result.headMismatch.join(', ')}`);
  }

  await db.destroy();
  process.exit(result.ok ? 0 : 2);
}

main().catch(async (err) => {
  console.error('audit:verify failed:', err instanceof Error ? err.message : err);
  try {
    await db.destroy();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
