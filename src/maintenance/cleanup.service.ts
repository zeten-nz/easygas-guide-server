import type { Knex } from 'knex';
import { db } from '../config/database';
import { env } from '../config/env';

/**
 * Phase 10C maintenance / retention.
 *
 * Deletes or recovers expired/stale runtime records in bounded batches. Dry-run
 * by default (counts only). Everything runs inside ONE transaction so a MySQL
 * named advisory lock (GET_LOCK) is held on a single pinned connection for the
 * whole run — making concurrent invocations safe (a second run no-ops) without
 * the connection-pool hazard of releasing a lock on a different connection.
 * Idempotent: re-running after an apply finds nothing left. Rate-limit keys are
 * intentionally NOT handled here — they expire on their own in Redis.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH = 1_000;
const STALE_PENDING_EVIDENCE_MS = 15 * 60 * 1000;

export interface CategoryResult {
  category: string;
  eligible: number;
  affected: number; // deleted/recovered when apply=true, else 0
  note?: string;
}
export interface CleanupResult {
  dryRun: boolean;
  categories: CategoryResult[];
}

async function countEligible(trx: Knex.Transaction, table: string, build: (q: any) => any): Promise<number> {
  const row = (await build(trx(table)).count({ c: '*' }).first()) as { c: number | string } | undefined;
  return Number(row?.c ?? 0);
}

async function deleteInBatches(trx: Knex.Transaction, table: string, build: (q: any) => any): Promise<number> {
  let total = 0;
  for (;;) {
    const ids = (await build(trx(table)).select('id').limit(BATCH)) as { id: number | string }[];
    if (ids.length === 0) break;
    total += await trx(table).whereIn('id', ids.map((r) => r.id)).del();
    if (ids.length < BATCH) break;
  }
  return total;
}

export async function runCleanup(opts: { apply?: boolean } = {}): Promise<CleanupResult> {
  const apply = opts.apply ?? false;

  return db.transaction(async (trx) => {
    // Non-blocking named lock on this transaction's pinned connection.
    const lockRes = (await trx.raw("SELECT GET_LOCK('eg:maintenance', 0) AS ok")) as [{ ok: number }[], unknown];
    if (lockRes[0]?.[0]?.ok !== 1) {
      return { dryRun: !apply, categories: [{ category: 'lock', eligible: 0, affected: 0, note: 'another maintenance run holds the lock — skipped' }] };
    }
    try {
      const now = Date.now();
      const categories: CategoryResult[] = [];

      // 1. Expired/revoked sessions (past retention).
      {
        const cutoff = new Date(now - env.SESSION_RETENTION_DAYS * DAY_MS);
        const where = (q: any) => q.where((b: any) => b.where('revoked_at', '<', cutoff).orWhere('absolute_expires_at', '<', cutoff));
        categories.push({ category: 'sessions', eligible: await countEligible(trx, 'sessions', where), affected: apply ? await deleteInBatches(trx, 'sessions', where) : 0 });
      }

      // 2. Expired/used password-reset (OTP) records (past retention).
      {
        const cutoff = new Date(now - env.OTP_RETENTION_DAYS * DAY_MS);
        const where = (q: any) => q.where('created_at', '<', cutoff);
        categories.push({ category: 'password_resets', eligible: await countEligible(trx, 'password_resets', where), affected: apply ? await deleteInBatches(trx, 'password_resets', where) : 0 });
      }

      // 3. Terminal SMS outbox records (past retention).
      {
        const cutoff = new Date(now - env.SMS_OUTBOX_RETENTION_DAYS * DAY_MS);
        const where = (q: any) => q.whereIn('status', ['SENT', 'DELIVERED', 'FAILED', 'CANCELLED']).where('updated_at', '<', cutoff);
        categories.push({ category: 'sms_outbox', eligible: await countEligible(trx, 'sms_outbox', where), affected: apply ? await deleteInBatches(trx, 'sms_outbox', where) : 0 });
      }

      // 4. Stale SMS PROCESSING leases → recover to RETRY (not deleted).
      {
        const where = (q: any) => q.where({ status: 'PROCESSING' }).whereNotNull('lease_expires_at').where('lease_expires_at', '<', new Date(now));
        const eligible = await countEligible(trx, 'sms_outbox', where);
        const affected = apply
          ? await trx('sms_outbox').where({ status: 'PROCESSING' }).whereNotNull('lease_expires_at').where('lease_expires_at', '<', new Date(now)).update({ status: 'RETRY', lease_owner: null, updated_at: trx.fn.now() })
          : 0;
        categories.push({ category: 'sms_stale_leases', eligible, affected, note: 'recovered to RETRY (not deleted)' });
      }

      // 5. Stale PENDING evidence — REPORT ONLY (coordinated with Phase 10B).
      //    The safe, audited fix is `npm run reconcile -- --apply`.
      {
        const cutoff = new Date(now - STALE_PENDING_EVIDENCE_MS);
        const photos = await countEligible(trx, 'job_photos', (q: any) => q.where({ status: 'PENDING' }).where('created_at', '<', cutoff));
        const sigs = await countEligible(trx, 'customer_signatures', (q: any) => q.where({ status: 'PENDING' }).where('created_at', '<', cutoff));
        categories.push({ category: 'stale_pending_evidence', eligible: photos + sigs, affected: 0, note: 'report-only — run `npm run reconcile -- --apply` to transition (audited)' });
      }

      return { dryRun: !apply, categories };
    } finally {
      await trx.raw("SELECT RELEASE_LOCK('eg:maintenance')").catch(() => undefined);
    }
  });
}
