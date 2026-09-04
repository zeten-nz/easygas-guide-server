import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('customers', (t) => {
    t.increments('id').primary();
    // loyiha.md §13: customer = ism (name) + telefon (phone). No extra CRM fields.
    t.string('name', 100).notNullable();
    t.string('phone', 20).notNullable();
    t.integer('created_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    // Soft-delete convention (matches users); no delete API yet — protects future Job history.
    t.timestamp('deleted_at').nullable();

    // Phone is the practical lookup key but intentionally NOT unique
    // (family members may share one phone; spec defines no uniqueness rule).
    t.index(['phone'], 'idx_customers_phone');
    t.index(['name'], 'idx_customers_name');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('customers');
}
