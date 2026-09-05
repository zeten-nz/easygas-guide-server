import type { Knex } from 'knex';
import { db } from '../../config/database';
import { computeEntryHash, genesisHash } from './audit-chain';

/**
 * Phase 10F — read-only audit-chain verification.
 *
 * Re-derives every chained entry's hash from its stored content and checks that
 * (a) the content hash matches `entry_hash` (detects in-place content tampering),
 * (b) `prev_hash` links to the previous entry's `entry_hash` (detects reordering/
 * substitution), and (c) `chain_seq` is contiguous from 1 (detects deletion of a
 * middle/tail row). Never repairs or deletes. Bounded/paginated per chain.
 *
 * Legacy rows (chain_id NULL, id <= the genesis checkpoint) are reported as
 * "legacy/unchained" and are NOT claimed to be integrity-verified.
 */

export interface ChainResult {
  chainId: string;
  entries: number;
  ok: boolean;
  error?: string;
}
export interface VerifyResult {
  ok: boolean;
  chains: ChainResult[];
  totalChained: number;
  legacyUnchained: number;
  headMismatch: string[];
}

function parseMaybeJson(v: unknown): unknown {
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

interface AuditRow {
  id: number;
  chain_id: string;
  chain_seq: number | string;
  prev_hash: string;
  entry_hash: string;
  user_id: number | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  old_value: unknown;
  new_value: unknown;
  ip: string | null;
  user_agent: string | null;
  created_at_fmt: string; // canonical 'YYYY-MM-DD HH:MM:SS.ffffff' (never re-derived)
}

async function verifyChain(conn: Knex, chainId: string, pageSize: number): Promise<ChainResult> {
  let expectedPrev = genesisHash(chainId);
  let expectedSeq = 1;
  let entries = 0;
  let after = 0; // paginate by chain_seq
  for (;;) {
    const rows = (await conn('audit_logs')
      .where({ chain_id: chainId })
      .andWhere('chain_seq', '>', after)
      .orderBy('chain_seq', 'asc')
      .limit(pageSize)
      .select('*', conn.raw("DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s.%f') as created_at_fmt"))) as AuditRow[];
    if (rows.length === 0) break;
    for (const r of rows) {
      const seq = Number(r.chain_seq);
      if (seq !== expectedSeq) {
        return { chainId, entries, ok: false, error: `seq gap: expected ${expectedSeq}, found ${seq} (deleted/reordered row?)` };
      }
      if (r.prev_hash !== expectedPrev) {
        return { chainId, entries, ok: false, error: `prev_hash mismatch at seq ${seq} (reordered/substituted?)` };
      }
      const recomputed = computeEntryHash({
        chainId,
        chainSeq: seq,
        prevHash: r.prev_hash,
        userId: r.user_id,
        action: r.action,
        entityType: r.entity_type,
        entityId: r.entity_id,
        oldValue: parseMaybeJson(r.old_value),
        newValue: parseMaybeJson(r.new_value),
        ip: r.ip,
        userAgent: r.user_agent,
        createdAt: r.created_at_fmt,
      });
      if (recomputed !== r.entry_hash) {
        return { chainId, entries, ok: false, error: `entry_hash mismatch at seq ${seq} (content tampered?)` };
      }
      expectedPrev = r.entry_hash;
      expectedSeq += 1;
      entries += 1;
      after = seq;
    }
    if (rows.length < pageSize) break;
  }
  return { chainId, entries, ok: true };
}

export async function verifyAuditChains(opts: { pageSize?: number; conn?: Knex; onlyChainId?: string } = {}): Promise<VerifyResult> {
  const conn = opts.conn ?? db;
  const pageSize = opts.pageSize ?? 1000;

  const chainQuery = conn('audit_logs').whereNotNull('chain_id').distinct('chain_id').orderBy('chain_id', 'asc');
  if (opts.onlyChainId) chainQuery.andWhere('chain_id', opts.onlyChainId);
  const chainIds = (await chainQuery).map((r: { chain_id: string }) => r.chain_id);
  const chains: ChainResult[] = [];
  for (const chainId of chainIds) chains.push(await verifyChain(conn, chainId, pageSize));

  const legacyQuery = conn('audit_logs').whereNull('chain_id').count({ c: '*' });
  const legacy = (await legacyQuery) as [{ c: number | string }];
  const legacyUnchained = opts.onlyChainId ? 0 : Number(legacy[0]?.c ?? 0);

  // Cross-check each head matches the last verified entry (skipped when scoped to
  // a single isolated chain that has no head row).
  const headMismatch: string[] = [];
  const headsQuery = conn('audit_chain_heads').select('chain_id', 'head_hash', 'head_seq');
  if (opts.onlyChainId) headsQuery.where('chain_id', opts.onlyChainId);
  const heads = (await headsQuery) as {
    chain_id: string;
    head_hash: string;
    head_seq: number | string;
  }[];
  for (const h of heads) {
    const last = (await conn('audit_logs').where({ chain_id: h.chain_id }).orderBy('chain_seq', 'desc').first()) as AuditRow | undefined;
    const expectedHash = last ? last.entry_hash : genesisHash(h.chain_id);
    const expectedSeq = last ? Number(last.chain_seq) : 0;
    if (h.head_hash !== expectedHash || Number(h.head_seq) !== expectedSeq) headMismatch.push(h.chain_id);
  }

  const ok = chains.every((c) => c.ok) && headMismatch.length === 0;
  const totalChained = chains.reduce((n, c) => n + c.entries, 0);
  return { ok, chains, totalChained, legacyUnchained, headMismatch };
}

/** Writes an exportable checkpoint (head hash/seq) per chain — anchor off-server. */
export async function writeCheckpoints(note: string, conn: Knex = db): Promise<number> {
  const heads = (await conn('audit_chain_heads').select('chain_id', 'head_hash', 'head_seq')) as {
    chain_id: string;
    head_hash: string;
    head_seq: number | string;
  }[];
  let n = 0;
  for (const h of heads) {
    await conn('audit_chain_checkpoints').insert({
      chain_id: h.chain_id,
      checkpoint_seq: Number(h.head_seq),
      checkpoint_hash: h.head_hash,
      note,
    });
    n += 1;
  }
  return n;
}
