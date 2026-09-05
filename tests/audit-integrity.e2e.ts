/**
 * EASY GAS — Phase 10F audit-chain integrity tests.
 *   npm run test:audit   (after: npm run test:setup)
 *
 * Covers: new audit entries are chained (incl. the event timestamp); concurrent
 * audit writers stay safe (head advances by exactly N, contiguous, no duplicate
 * seq); audit_logs is append-only (UPDATE blocked at the DB); and verification
 * detects tampering of EVERY hashed field class — content, created_at, actor,
 * action, entity id, prev_hash, and deletion (seq gap) — on ISOLATED crafted
 * chains, so the shared chain (which other suites prune during cleanup) is never
 * relied upon.
 */
import './helpers/test-env';
import assert from 'node:assert/strict';
import { db } from '../src/config/database';
import { createApp } from '../src/app';
import { setSmsProviderForTesting } from '../src/sms';
import { setStorageProviderForTesting } from '../src/storage';
import { MemoryStorageProvider } from './helpers/memory-storage';
import { computeEntryHash, genesisHash, utcChainId, type ChainFields } from '../src/modules/audit/audit-chain';
import { verifyAuditChains } from '../src/modules/audit/audit-verify';

const DEMO = { phone: '+998901000001', password: 'EasyGasDev2026!' };
const TS = '2099-01-01 10:00:00.000000';

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

type Fields = Omit<ChainFields, 'chainSeq' | 'prevHash'>;

/**
 * Crafts one chained row. `hashed` are the field values the entry_hash is computed
 * over; `stored` optionally overrides what is actually persisted (to simulate a
 * post-hoc tamper of a single field). `storedPrevHash` tampers the link column.
 */
async function craft(
  chainId: string,
  seq: number,
  prevHash: string,
  hashed: Partial<Fields>,
  stored: Partial<Fields> = {},
  storedPrevHash?: string,
): Promise<string> {
  const h: ChainFields = {
    chainId,
    chainSeq: seq,
    prevHash,
    userId: hashed.userId ?? null,
    action: hashed.action ?? 'LOGIN',
    entityType: hashed.entityType ?? null,
    entityId: hashed.entityId ?? null,
    oldValue: hashed.oldValue ?? null,
    newValue: hashed.newValue ?? null,
    ip: hashed.ip ?? null,
    userAgent: hashed.userAgent ?? null,
    createdAt: hashed.createdAt ?? TS,
  };
  const entryHash = computeEntryHash(h);
  const s = { ...h, ...stored };
  await db('audit_logs').insert({
    user_id: s.userId ?? null,
    action: s.action,
    entity_type: s.entityType ?? null,
    entity_id: s.entityId ?? null,
    old_value: s.oldValue != null ? JSON.stringify(s.oldValue) : null,
    new_value: s.newValue != null ? JSON.stringify(s.newValue) : null,
    ip: s.ip ?? null,
    user_agent: s.userAgent ?? null,
    created_at: s.createdAt,
    chain_id: chainId,
    chain_seq: seq,
    prev_hash: storedPrevHash ?? prevHash,
    entry_hash: entryHash,
  });
  return entryHash;
}

async function run(): Promise<void> {
  setSmsProviderForTesting({ name: 'test', send: async () => ({ providerMessageId: null, outcome: 'ACCEPTED' as const }) });
  setStorageProviderForTesting(new MemoryStorageProvider());
  await db('audit_logs').where('chain_id', 'like', '2099-%').del();

  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  console.log(`\nRunning audit-integrity E2E against ${baseUrl}\n`);

  // ---- 1. New entries are chained + recompute (incl. created_at) ----
  await test('a real audited action produces a chained entry that recomputes correctly (created_at hashed)', async () => {
    assert.equal(await login(), 200);
    const row = await db('audit_logs')
      .where({ action: 'LOGIN' })
      .orderBy('id', 'desc')
      .select('*', db.raw("DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s.%f') as created_at_fmt"))
      .first();
    assert.ok(row.chain_id && row.chain_seq && row.prev_hash && row.entry_hash && row.created_at_fmt, 'chain + timestamp fields populated');
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
      createdAt: row.created_at_fmt,
    });
    assert.equal(recomputed, row.entry_hash);
  });

  // ---- 2. Concurrency ----
  await test('concurrent audited actions produce a contiguous, non-duplicated chain segment', async () => {
    process.env.E2E_DISABLE_RATE_LIMIT = '1';
    const chainId = utcChainId();
    const before = (await db('audit_chain_heads').where({ chain_id: chainId }).first()) as { head_seq: number | string } | undefined;
    const beforeSeq = before ? Number(before.head_seq) : 0;
    const N = 15;
    const results = await Promise.all(Array.from({ length: N }, () => login()));
    assert.ok(results.every((s) => s === 200));
    const after = (await db('audit_chain_heads').where({ chain_id: chainId }).first()) as { head_seq: number | string };
    assert.equal(Number(after.head_seq) - beforeSeq, N, `head_seq advances by exactly ${N}`);
    const rows = await db('audit_logs').where({ chain_id: chainId }).andWhere('chain_seq', '>', beforeSeq).andWhere('chain_seq', '<=', beforeSeq + N);
    assert.equal(new Set(rows.map((r: { chain_seq: number | string }) => Number(r.chain_seq))).size, N, 'no duplicate chain_seq');
    process.env.E2E_DISABLE_RATE_LIMIT = '';
  });

  // ---- 3. Append-only ----
  await test('audit_logs is append-only (UPDATE refused by the DB)', async () => {
    const row = await db('audit_logs').orderBy('id', 'desc').first();
    await assert.rejects(() => db('audit_logs').where({ id: row.id }).update({ action: 'TAMPERED' }), /append-only|SIGNAL|1644|45000/i);
  });

  // ---- 4. Good chain verifies ----
  await test('a correctly-built chain verifies OK', async () => {
    const C = '2099-02-01';
    const h1 = await craft(C, 1, genesisHash(C), { newValue: { step: 1 } });
    const h2 = await craft(C, 2, h1, { newValue: { step: 2 } });
    await craft(C, 3, h2, { newValue: { step: 3 } });
    assert.equal((await verifyAuditChains({ onlyChainId: C })).ok, true);
  });

  // ---- 5. Per-field tamper detection ----
  const tamperCases: { name: string; chain: string; hashed: Partial<Fields>; stored: Partial<Fields>; storedPrev?: string; expect: RegExp }[] = [
    { name: 'content (new_value)', chain: '2099-03-01', hashed: { newValue: { a: 1 } }, stored: { newValue: { a: 999 } }, expect: /entry_hash mismatch/ },
    { name: 'created_at (event time)', chain: '2099-03-02', hashed: { createdAt: TS }, stored: { createdAt: '2099-01-01 10:00:00.500000' }, expect: /entry_hash mismatch/ },
    { name: 'actor (user_id)', chain: '2099-03-03', hashed: { userId: 1 }, stored: { userId: 2 }, expect: /entry_hash mismatch/ },
    { name: 'action', chain: '2099-03-04', hashed: { action: 'LOGIN' }, stored: { action: 'LOGOUT' }, expect: /entry_hash mismatch/ },
    { name: 'entity_id', chain: '2099-03-05', hashed: { entityType: 'job', entityId: '10' }, stored: { entityType: 'job', entityId: '11' }, expect: /entry_hash mismatch/ },
    { name: 'prev_hash link', chain: '2099-03-06', hashed: {}, stored: {}, storedPrev: 'f'.repeat(64), expect: /prev_hash mismatch/ },
  ];
  for (const tc of tamperCases) {
    await test(`tampering ${tc.name} is detected`, async () => {
      const r = await craft(tc.chain, 1, genesisHash(tc.chain), tc.hashed, tc.stored, tc.storedPrev);
      void r;
      const res = await verifyAuditChains({ onlyChainId: tc.chain });
      assert.equal(res.ok, false, `expected failure for ${tc.name}`);
      assert.match(res.chains[0].error ?? '', tc.expect);
    });
  }

  // ---- 6. Deletion / reorder (seq gap) ----
  await test('deletion is detected (chain_seq gap)', async () => {
    const C = '2099-04-01';
    const h1 = await craft(C, 1, genesisHash(C), { newValue: { step: 1 } });
    const h2 = await craft(C, 2, h1, { newValue: { step: 2 } });
    await craft(C, 4, h2, { newValue: { step: 4 } });
    const res = await verifyAuditChains({ onlyChainId: C });
    assert.equal(res.ok, false);
    assert.match(res.chains[0].error ?? '', /seq gap/);
  });

  await db('audit_logs').where('chain_id', 'like', '2099-%').del();
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
