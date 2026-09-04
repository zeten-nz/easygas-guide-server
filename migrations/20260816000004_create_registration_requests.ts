import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('registration_requests', (t) => {
    t.increments('id').primary();
    t.string('first_name', 50).notNullable();
    t.string('last_name', 50).notNullable();
    t.string('phone', 20).notNullable();
    t.string('region', 60).notNullable();
    t.integer('branch_id').unsigned().notNullable().references('id').inTable('branches').onDelete('RESTRICT');
    t.string('comment', 500).nullable();
    // Hashed at submission time; copied to users.password_hash on approval.
    t.string('password_hash', 100).notNullable();
    t.string('status', 20).notNullable().defaultTo('PENDING');
    t.integer('reviewed_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('reviewed_at').nullable();
    t.string('reject_reason', 500).nullable();
    t.integer('created_user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    t.index(['phone'], 'idx_registration_requests_phone');
    t.index(['status'], 'idx_registration_requests_status');
    t.index(['branch_id'], 'idx_registration_requests_branch');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('registration_requests');
}
