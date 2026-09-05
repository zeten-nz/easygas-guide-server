/**
 * EASY GAS — Phase 10F audit-chain integrity tests.
 *   npm run test:audit   (after: npm run test:setup)
 *
 * Covers: new audit entries are chained; concurrent audit writers stay safe
 * (head advances by exactly N, contiguous, no duplicate seq); audit_logs is
 * append-only (UPDATE blocked at the DB); and verification detects content
 * tampering and deletion/reordering (on ISOLATED crafted chains, so the shared
 * chain — which other suites prune during cleanup — is never relied upon).
 */
import './helpers/test-env';
import assert from 'node:assert/strict';
import { db } from '../src/config/database';
import { createApp } from '../src/app';
import { setSmsProviderForTesting } from '../src/sms';
import { setStorageProviderForTesting } from '../src/storage';
import { MemoryStorageProvider } from './helpers/memory-storage';
import { computeEntryHash, genesisHash, utcChainId } from '../src/modules/audit/audit-chain';
import { verifyAuditChains } from '../src/modules/audit/audit-verify';

const DEMO = { phone: '+998901000001', password: 'EasyGasDev2026!' };

let baseUrl = '';
async function login(): Promise<number> {
  const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: DEMO.phone, password: DEMO.password, rememberMe: false }),
  });
  return res.status;
}

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.stack : String(err)}`);
  }
}

async function craft(chainId: string, seq: number, prevHash: string, newValue: unknown, override?: { storedNewValue?: unknown }): Promise<string> {
  const hashInput = { chainId, chainSeq: seq, prevHash, userId: null, action: 'LOGIN', entityType: null, entityId: null, oldValue: null, newValue, ip: null, userAgent: null };
  const entryHash = computeEntryHash(hashInput);
  const stored = override && 'storedNewValue' in override ? override.storedNewValue : newValue;
  await db('audit_logs').insert({
    action: 'LOGIN',
    new_value: stored != null ? JSON.stringify(stored) : null,
    chain_id: chainId,
    chain_seq: seq,
    prev_hash: prevHash,
    entry_hash: entryHash,
  });
  return entryHash;
}

async function run(): Promise<void> {
  setSmsProviderForTesting({ name: 'test', send: async () => ({ providerMessageId: null, outcome: 'ACCEPTED' as const }) });
  setStorageProviderForTesting(new MemoryStorageProvider());

  await db('audit_logs').where('chain_id', 'like', '2099-%').del(); // clean any prior isolated rows

  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  console.log(`\nRunning audit-integrity E2E against ${baseUrl}\n`);

  // ---- 1. New audit entries are chained + recompute correctly ----
  await test('a real audited action produces a chained entry that recomputes correctly', async () => {
    assert.equal(await login(), 200);
    const row = await db('audit_logs').where({ action: 'LOGIN' }).orderBy('id', 'desc').first();
    assert.ok(row.chain_id && row.chain_seq && row.prev_hash && row.entry_hash, 'chain fields must be populated');
    const recomputed = computeEntryHash({
      chainId: row.chain_id,
      chainSeq: Number(row.chain_seq),
      prevHash: row.prev_hash,
      userId: row.user_id,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      oldValue: row.old_value,
      newValue: row.new_value,
      ip: row.ip,
      userAgent: row.user_agent,
    });
    assert.equal(recomputed, row.entry_hash, 'stored entry_hash must equal the recomputed hash');
  });

  // ---- 2. Concurrent audit writers stay safe (head advances by exactly N) ----
  await test('concurrent audited actions produce a contiguous, non-duplicated chain segment', async () => {
    process.env.E2E_DISABLE_RATE_LIMIT = '1'; // allow many rapid logins (test-only, non-prod)
    const chainId = utcChainId();
    const before = (await db('audit_chain_heads').where({ chain_id: chainId }).first()) as { head_seq: number | string } | undefined;
    const beforeSeq = before ? Number(before.head_seq) : 0;

    const N = 15;
    const results = await Promise.all(Array.from({ length: N }, () => login()));
    assert.ok(results.every((s) => s === 200), 'all concurrent logins succeed');

    const after = (await db('audit_chain_heads').where({ chain_id: chainId }).first()) as { head_seq: number | string };
    assert.equal(Number(after.head_seq) - beforeSeq, N, `head_seq must advance by exactly ${N}`);

    // The N new rows occupy contiguous, unique seqs and chain correctly.
    const rows = await db('audit_logs')
      .where({ chain_id: chainId })
      .andWhere('chain_seq', '>', beforeSeq)
      .andWhere('chain_seq', '<=', beforeSeq + N)
      .orderBy('chain_seq', 'asc');
    assert.equal(rows.length, N, 'exactly N new rows');
    const seqs = new Set(rows.map((r: { chain_seq: number | string }) => Number(r.chain_seq)));
    assert.equal(seqs.size, N, 'no duplicate chain_seq under concurrency');
    process.env.E2E_DISABLE_RATE_LIMIT = '';
  });

  // ---- 3. Append-only: UPDATE is blocked at the DB layer ----
  await test('audit_logs is append-only (UPDATE is refused by the DB)', async () => {
    const row = await db('audit_logs').orderBy('id', 'desc').first();
    await assert.rejects(() => db('audit_logs').where({ id: row.id }).update({ action: 'TAMPERED' }), /append-only|SIGNAL|1644|45000/i);
  });

  // ---- 4. A well-formed isolated chain verifies OK ----
  await test('a correctly-built chain verifies OK', async () => {
    const C = '2099-01-02';
    const h1 = await craft(C, 1, genesisHash(C), { step: 1 });
    const h2 = await craft(C, 2, h1, { step: 2 });
    await craft(C, 3, h2, { step: 3 });
    const r = await verifyAuditChains({ onlyChainId: C });
    assert.equal(r.ok, true, JSON.stringify(r.chains));
  });

  // ---- 5. Content tampering is detected ----
  await test('content tampering is detected (entry_hash mismatch)', async () => {
    const C = '2099-01-03';
    const h1 = await craft(C, 1, genesisHash(C), { step: 1 });
    // seq 2: entry_hash computed over {step:2} but STORE {step:999} → mismatch.
    await craft(C, 2, h1, { step: 2 }, { storedNewValue: { step: 999 } });
    const r = await verifyAuditChains({ onlyChainId: C });
    assert.equal(r.ok, false);
    assert.match(r.chains[0].error ?? '', /entry_hash mismatch/);
  });

  // ---- 6. Deletion / reordering is detected (seq gap) ----
  await test('deletion is detected (chain_seq gap)', async () => {
    const C = '2099-01-04';
    const h1 = await craft(C, 1, genesisHash(C), { step: 1 });
    const h2 = await craft(C, 2, h1, { step: 2 });
    await craft(C, 4, h2, { step: 4 }); // seq 3 "deleted"
    const r = await verifyAuditChains({ onlyChainId: C });
    assert.equal(r.ok, false);
    assert.match(r.chains[0].error ?? '', /seq gap/);
  });

  await db('audit_logs').where('chain_id', 'like', '2099-%').del(); // cleanup isolated chains
  await db.destroy();
  server.close();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

run().catch(async (err) => {
  console.error(err);
  try { await db.destroy(); } catch { /* ignore */ }
  process.exit(1);
});
