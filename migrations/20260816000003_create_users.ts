import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('users', (t) => {
    t.increments('id').primary();
    t.string('first_name', 50).notNullable();
    t.string('last_name', 50).notNullable();
    t.string('phone', 20).notNullable().unique('uq_users_phone');
    // Passwords are stored ONLY as bcrypt hashes — never plaintext.
    t.string('password_hash', 100).notNullable();
    t.string('avatar_url', 500).nullable();
    t.string('region', 60).notNullable();
    // Nullable: SIFAT/ADMIN are cross-branch roles.
    t.integer('branch_id').unsigned().nullable().references('id').inTable('branches').onDelete('RESTRICT');
    t.integer('role_id').unsigned().notNullable().references('id').inTable('roles').onDelete('RESTRICT');
    t.string('status', 20).notNullable().defaultTo('ACTIVE');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('last_login_at').nullable();
    t.timestamp('deleted_at').nullable();

    t.index(['status'], 'idx_users_status');
    t.index(['role_id'], 'idx_users_role');
    t.index(['branch_id'], 'idx_users_branch');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('users');
}
