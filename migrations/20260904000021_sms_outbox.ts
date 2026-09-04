import type { Knex } from 'knex';

/**
 * Phase 10C — durable SMS outbox.
 *
 * Replaces the fragile "insert OTP then directly call the provider" flow. A
 * message is persisted first (PENDING), then a worker leases and delivers it
 * with retries/backoff, so a provider or process failure never loses (or
 * silently duplicates) an OTP. The rendered body is stored ENCRYPTED
 * (payload_cipher, AES-256-GCM) — no plaintext OTP at rest.
 *
 * States: PENDING → PROCESSING (leased) → SENT (accepted by provider)
 *                                        → DELIVERED (only if the provider
 *                                          confirms handset delivery)
 *                                        → RETRY (transient failure, backoff)
 *                                        → FAILED (permanent / max attempts /
 *                                          ambiguous timeout — see last_error)
 *                                        → CANCELLED (superseded, or too old to
 *                                          deliver — an OTP must not arrive
 *                                          after it has expired)
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('sms_outbox')) return;
  await knex.schema.createTable('sms_outbox', (t) => {
    t.bigIncrements('id').primary();
    t.string('type', 24).notNullable(); // e.g. OTP
    t.integer('user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    // Normalized recipient (+998XXXXXXXXX). Not treated as a secret, but never logged.
    t.string('recipient', 20).notNullable();
    t.string('template_key', 40).nullable();
    // AES-256-GCM ciphertext of the rendered body (ivHex:tagHex:ctHex). Never plaintext.
    t.text('payload_cipher').notNullable();
    t.string('status', 12).notNullable().defaultTo('PENDING');
    t.integer('attempts').unsigned().notNullable().defaultTo(0);
    t.integer('max_attempts').unsigned().notNullable().defaultTo(5);
    t.timestamp('next_attempt_at').notNullable().defaultTo(knex.fn.now());
    // A message picked up after not_after is CANCELLED, not delivered.
    t.timestamp('not_after').notNullable();
    // Lease (claim) ownership for multi-worker safety.
    t.string('lease_owner', 64).nullable();
    t.timestamp('lease_expires_at').nullable();
    t.string('provider', 24).nullable();
    t.string('provider_message_id', 64).nullable();
    // Sanitized error classification only (never provider bodies/credentials).
    t.string('last_error', 60).nullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('sent_at').nullable();
    t.timestamp('failed_at').nullable();

    // Claim query: status + eligibility time.
    t.index(['status', 'next_attempt_at'], 'idx_sms_outbox_claim');
    t.index(['lease_expires_at'], 'idx_sms_outbox_lease');
    t.index(['recipient', 'status'], 'idx_sms_outbox_recipient');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('sms_outbox');
}
