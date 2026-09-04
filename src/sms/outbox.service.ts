import type { Knex } from 'knex';
import { db } from '../config/database';
import { env } from '../config/env';
import { encryptSecret } from '../utils/crypto';
import { normalizePhone } from '../utils/phone';

/**
 * Phase 10C durable SMS outbox — enqueue side.
 *
 * A message is persisted (encrypted) as PENDING inside the caller's transaction,
 * so it is committed atomically with whatever produced it (e.g. the OTP row) and
 * a worker delivers it later. Enqueue also supersedes the recipient's earlier
 * still-queued messages of the same type, so a burst of resend requests cannot
 * leave several deliverable OTP messages.
 */

export type SmsStatus = 'PENDING' | 'PROCESSING' | 'SENT' | 'DELIVERED' | 'RETRY' | 'FAILED' | 'CANCELLED';

export interface SmsOutboxRow {
  id: number;
  type: string;
  user_id: number | null;
  recipient: string;
  template_key: string | null;
  payload_cipher: string;
  status: SmsStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: Date;
  not_after: Date;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  provider: string | null;
  provider_message_id: string | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  sent_at: Date | null;
  failed_at: Date | null;
}

export interface EnqueueOtpInput {
  userId: number | null;
  phone: string;
  message: string;
}

/**
 * Enqueues an OTP SMS inside an existing transaction. Supersedes the recipient's
 * still-queued OTP messages first (PENDING/RETRY only — a PROCESSING one may
 * already be sending, and its now-superseded code is harmless since the OTP row
 * was invalidated in the same transaction). The rendered body is encrypted at
 * rest; the plaintext OTP is never persisted.
 */
export async function enqueueOtpSms(trx: Knex.Transaction, input: EnqueueOtpInput): Promise<number> {
  const recipient = normalizePhone(input.phone);
  await trx('sms_outbox')
    .where({ recipient, type: 'OTP' })
    .whereIn('status', ['PENDING', 'RETRY'])
    .update({ status: 'CANCELLED', last_error: 'SUPERSEDED', updated_at: trx.fn.now() });

  // Clock discipline: `next_attempt_at` is compared via SQL NOW() in the worker
  // claim, so it is written on the DB clock (trx.fn.now). `not_after` is compared
  // in JS (deliver()), so it is a JS Date — each value is compared on the same
  // clock it was written on, avoiding any Node/MySQL timezone skew.
  const [id] = await trx('sms_outbox').insert({
    type: 'OTP',
    user_id: input.userId,
    recipient,
    template_key: 'otp_reset_v1',
    payload_cipher: encryptSecret(input.message),
    status: 'PENDING',
    attempts: 0,
    max_attempts: env.SMS_MAX_ATTEMPTS,
    next_attempt_at: trx.fn.now(),
    not_after: new Date(Date.now() + env.SMS_MAX_AGE_SECONDS * 1000),
  });
  return id as number;
}

/** Non-transactional convenience (used by non-OTP callers / tests). */
export async function enqueueOtpSmsStandalone(input: EnqueueOtpInput): Promise<number> {
  return db.transaction((trx) => enqueueOtpSms(trx, input));
}
