import type { Knex } from 'knex';

/**
 * Safe, audited transition of obsolete recovery SMS (product decision: OTP
 * self-service recovery is removed; SMS is disabled unless a real provider is
 * explicitly selected). Any recovery SMS still queued for delivery must NEVER be
 * sent now that the OTP it carried has been invalidated — an OTP arriving after
 * this change would be both useless and confusing.
 *
 * This CANCELS every non-terminal recovery message (PENDING / RETRY / PROCESSING)
 * by moving it to the existing terminal CANCELLED state with a clear marker. It is
 * deliberately conservative:
 *   - history is PRESERVED — rows are updated in place, never deleted; the table
 *     and all already-delivered/failed rows are untouched;
 *   - terminal rows (SENT / DELIVERED / FAILED / already CANCELLED) are left as-is;
 *   - it is idempotent — re-running matches nothing the second time;
 *   - it does not drop tables or rewrite merged migrations.
 *
 * DEPLOY SEQUENCING (operator — see docs/PRODUCTION-RUNTIME-10C.md):
 *   1. Deploy the new build with SMS disabled (SMS_PROVIDER unset). The API no
 *      longer calls startWorker(), and even if invoked the worker fails closed
 *      (startWorker + runOnce both refuse when the provider is not `ready`).
 *   2. STOP AND DRAIN the previous dedicated worker (`easygas-sms-worker`) BEFORE
 *      running this migration: `pm2 stop easygas-sms-worker` triggers the app's
 *      graceful stop, which awaits the in-flight batch (stopWorker()), so no row
 *      is mid-send when the migration runs. Reload/replace it with the new build.
 *   3. THEN run this migration. Because the worker is drained, there are no live
 *      PROCESSING rows; any PROCESSING row that remains is a CRASHED worker's stale
 *      lease (its provider outcome is unknown/AMBIGUOUS) — cancelling it prevents a
 *      duplicate re-send and is the correct choice while retiring recovery SMS.
 *
 * ALREADY-IN-FLIGHT SENDS: a DB migration CANNOT retract a message a worker has
 * already handed to the SMS provider — marking such a row CANCELLED only records
 * that we will not retry it, not that the provider un-sent it. The drain in step 2
 * is what guarantees nothing is in flight when this runs; there is no way to recall
 * an OTP already accepted by the gateway, and this migration does not pretend to.
 *
 * With SMS disabled the worker does not run and no new recovery SMS is ever
 * enqueued (the OTP endpoints are gone), so cancelled rows stay cancelled. `down`
 * is intentionally a NO-OP: it does NOT resurrect cancelled OTPs (un-cancelling
 * them would be unsafe, and the original queued/processing state cannot be
 * reconstructed) — a rollback leaves history intact and the messages retired.
 */
const NON_TERMINAL = ['PENDING', 'RETRY', 'PROCESSING'];

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('sms_outbox'))) return;

  await knex('sms_outbox')
    .where({ type: 'OTP' })
    .whereIn('status', NON_TERMINAL)
    .update({
      status: 'CANCELLED',
      last_error: 'RECOVERY_SMS_RETIRED',
      lease_owner: null,
      lease_expires_at: null,
      failed_at: knex.fn.now(),
      updated_at: knex.fn.now(),
    });
}

export async function down(): Promise<void> {
  // Intentionally irreversible: cancelled recovery messages must not be revived.
}
