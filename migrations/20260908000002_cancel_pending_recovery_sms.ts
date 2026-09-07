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
 * With SMS disabled the worker does not run (see server.ts) and no new recovery
 * SMS is ever enqueued (the OTP endpoints are gone), so cancelled rows stay
 * cancelled. `down` is intentionally a no-op: un-cancelling messages to make them
 * deliverable again would be unsafe, and the original queued/processing state
 * cannot be reconstructed.
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
