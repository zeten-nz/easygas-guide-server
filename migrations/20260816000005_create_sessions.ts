import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('sessions', (t) => {
    t.uuid('id').primary();
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    // SHA-256 of the opaque 256-bit session token; the raw token lives only in the HTTP-only cookie.
    t.string('token_hash', 64).notNullable().unique('uq_sessions_token_hash');
    t.boolean('remember_me').notNullable().defaultTo(false);
    t.timestamp('expires_at').notNullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('last_used_at').notNullable().defaultTo(knex.fn.now());
    // Set on logout / admin revocation — a revoked session can never authenticate again.
    t.timestamp('revoked_at').nullable();
    t.string('ip', 45).nullable();
    t.string('user_agent', 500).nullable();

    t.index(['user_id'], 'idx_sessions_user');
    t.index(['expires_at'], 'idx_sessions_expires');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('sessions');
}
