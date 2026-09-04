import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('password_resets', (t) => {
    t.increments('id').primary();
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('phone', 20).notNullable();
    // HMAC-SHA256(APP_KEY) of the 6-digit OTP — the code itself is never stored or logged.
    t.string('otp_hash', 64).notNullable();
    t.timestamp('otp_expires_at').notNullable();
    t.integer('attempts').unsigned().notNullable().defaultTo(0);
    // Set when the OTP is used (single-use) or superseded by a newer code.
    t.timestamp('consumed_at').nullable();
    // Short-lived token issued after successful OTP verification.
    t.string('reset_token_hash', 64).nullable().unique('uq_password_resets_reset_token');
    t.timestamp('reset_token_expires_at').nullable();
    t.timestamp('reset_used_at').nullable();
    t.string('request_ip', 45).nullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    t.index(['phone'], 'idx_password_resets_phone');
    t.index(['user_id'], 'idx_password_resets_user');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('password_resets');
}
