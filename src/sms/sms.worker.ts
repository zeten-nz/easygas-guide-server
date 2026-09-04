import crypto from 'node:crypto';
import os from 'node:os';
import { db } from '../config/database';
import { env } from '../config/env';
import { decryptSecret } from '../utils/crypto';
import { logger } from '../utils/logger';
import { getSmsProvider } from './index';
import { SmsSendError } from './sms.provider';
import type { SmsOutboxRow } from './outbox.service';

/**
 * Phase 10C durable SMS worker.
 *
 * Claims outbox rows with a DB lease (safe across PM2 instances — no process
 * mutex), delivers them with bounded concurrency and exponential backoff + full
 * jitter, recovers stale leases, and cancels messages too old to deliver. An
 * ambiguous provider timeout is recorded (not blindly retried) for operator
 * reconciliation. Logs are structured and never contain the message body/OTP.
 */

const WORKER_ID = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`.slice(0, 64);
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const CLAIM_CONCURRENCY = 5;

let intervalHandle: NodeJS.Timeout | null = null;
let stopping = false;
let inFlight: Promise<unknown> | null = null;

function backoffMs(attempts: number): number {
  const exp = Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
  return Math.floor(exp * (0.8 + Math.random() * 0.4)); // full-ish jitter ±20%
}

/** Recovers rows whose PROCESSING lease has expired (a crashed/slow worker). */
async function recoverStaleLeases(): Promise<void> {
  await db('sms_outbox')
    .where({ status: 'PROCESSING' })
    .whereNotNull('lease_expires_at')
    .where('lease_expires_at', '<', db.fn.now())
    .update({ status: 'RETRY', lease_owner: null, updated_at: db.fn.now() });
}

/**
 * Claims up to `limit` due rows for this worker. Uses a per-row conditional
 * UPDATE (atomic, no SKIP LOCKED dependency) so two workers never claim the same
 * row: only one UPDATE's WHERE matches.
 */
async function claim(limit: number): Promise<SmsOutboxRow[]> {
  const candidates = (await db('sms_outbox')
    .whereIn('status', ['PENDING', 'RETRY'])
    .where('next_attempt_at', '<=', db.fn.now())
    .orderBy('next_attempt_at', 'asc')
    .limit(limit)
    .select('id')) as { id: number }[];

  const claimed: SmsOutboxRow[] = [];
  for (const c of candidates) {
    const n = await db('sms_outbox')
      .where({ id: c.id })
      .whereIn('status', ['PENDING', 'RETRY'])
      .where('next_attempt_at', '<=', db.fn.now())
      // lease expiry on the DB clock so stale-lease recovery (a SQL NOW()
      // comparison) is never skewed by a Node/MySQL timezone difference.
      .update({
        status: 'PROCESSING',
        lease_owner: WORKER_ID,
        lease_expires_at: db.raw('DATE_ADD(NOW(), INTERVAL ? SECOND)', [env.SMS_LEASE_SECONDS]),
        updated_at: db.fn.now(),
      });
    if (n === 1) {
      const row = (await db('sms_outbox').where({ id: c.id }).first()) as SmsOutboxRow;
      claimed.push(row);
    }
  }
  return claimed;
}

async function markTerminal(id: number, patch: Record<string, unknown>): Promise<void> {
  await db('sms_outbox').where({ id }).update({ ...patch, lease_owner: null, lease_expires_at: null, updated_at: db.fn.now() });
}

async function deliver(row: SmsOutboxRow): Promise<void> {
  // Too old to deliver → cancel (an OTP must not arrive after it has expired).
  if (new Date(row.not_after).getTime() <= Date.now()) {
    await markTerminal(row.id, { status: 'CANCELLED', last_error: 'EXPIRED_BEFORE_SEND', failed_at: db.fn.now() });
    logger.info({ outboxId: row.id, type: row.type }, 'SMS cancelled: expired before send');
    return;
  }

  const attempts = row.attempts + 1;
  let message: string;
  try {
    message = decryptSecret(row.payload_cipher);
  } catch {
    await markTerminal(row.id, { status: 'FAILED', attempts, last_error: 'PAYLOAD_DECRYPT', failed_at: db.fn.now() });
    logger.error({ outboxId: row.id }, 'SMS failed: payload decrypt error');
    return;
  }

  const provider = getSmsProvider();
  try {
    const result = await provider.send(row.recipient, message);
    await markTerminal(row.id, {
      status: result.outcome === 'DELIVERED' ? 'DELIVERED' : 'SENT',
      attempts,
      provider: provider.name,
      provider_message_id: result.providerMessageId,
      last_error: null,
      sent_at: db.fn.now(),
    });
    logger.info({ outboxId: row.id, type: row.type, provider: provider.name, outcome: result.outcome }, 'SMS accepted by provider');
  } catch (err) {
    const kind = err instanceof SmsSendError ? err.kind : 'RETRYABLE';
    const code = err instanceof SmsSendError ? err.code : 'SEND_ERROR';
    if (kind === 'AMBIGUOUS') {
      // The gateway may already have accepted it — do NOT retry (avoid a
      // duplicate OTP). Record for operator reconciliation.
      await markTerminal(row.id, { status: 'FAILED', attempts, last_error: `AMBIGUOUS:${code}`.slice(0, 60), failed_at: db.fn.now() });
      logger.warn({ outboxId: row.id, code }, 'SMS ambiguous timeout — recorded for reconciliation, not retried');
      return;
    }
    if (kind === 'PERMANENT' || attempts >= row.max_attempts) {
      await markTerminal(row.id, { status: 'FAILED', attempts, last_error: `${kind}:${code}`.slice(0, 60), failed_at: db.fn.now() });
      logger.warn({ outboxId: row.id, kind, code, attempts }, 'SMS permanently failed');
      return;
    }
    // Retryable + attempts remain → schedule with backoff (DB clock).
    await db('sms_outbox').where({ id: row.id }).update({
      status: 'RETRY',
      attempts,
      last_error: `${kind}:${code}`.slice(0, 60),
      next_attempt_at: db.raw('DATE_ADD(NOW(), INTERVAL ? SECOND)', [Math.ceil(backoffMs(attempts) / 1000)]),
      lease_owner: null,
      lease_expires_at: null,
      updated_at: db.fn.now(),
    });
    logger.info({ outboxId: row.id, attempts, code }, 'SMS retry scheduled');
  }
}

async function processPool(rows: SmsOutboxRow[]): Promise<void> {
  let next = 0;
  async function w(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= rows.length) return;
      await deliver(rows[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CLAIM_CONCURRENCY, rows.length || 1) }, () => w()));
}

/** One worker cycle: recover stale leases, claim a bounded batch, deliver. */
export async function runOnce(): Promise<{ claimed: number }> {
  if (stopping) return { claimed: 0 };
  await recoverStaleLeases();
  const rows = await claim(env.SMS_WORKER_BATCH);
  if (rows.length === 0) return { claimed: 0 };
  const p = processPool(rows);
  inFlight = p;
  try {
    await p;
  } finally {
    inFlight = null;
  }
  return { claimed: rows.length };
}

export function startWorker(): void {
  if (intervalHandle || !env.SMS_WORKER_ENABLED) return;
  stopping = false;
  intervalHandle = setInterval(() => {
    runOnce().catch((err) => logger.error({ err: (err as Error)?.message }, 'SMS worker cycle error'));
  }, env.SMS_WORKER_INTERVAL_MS);
  intervalHandle.unref?.();
  logger.info({ worker: WORKER_ID }, 'SMS outbox worker started');
}

/** Graceful stop: stop claiming new work and let the in-flight batch drain. */
export async function stopWorker(): Promise<void> {
  stopping = true;
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  if (inFlight) await inFlight.catch(() => undefined);
}

/** Test helper: reset the module stop flag between suites. */
export function resetWorkerForTesting(): void {
  stopping = false;
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
