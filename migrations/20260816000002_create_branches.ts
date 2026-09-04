import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('branches', (t) => {
    t.increments('id').primary();
    t.string('name', 150).notNullable();
    t.string('region', 60).notNullable();
    t.string('address', 255).nullable();
    t.string('phone', 20).nullable();
    t.string('status', 20).notNullable().defaultTo('ACTIVE');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    t.index(['status'], 'idx_branches_status');
    t.index(['region'], 'idx_branches_region');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('branches');
}
