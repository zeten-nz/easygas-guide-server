import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('vehicles', (t) => {
    t.increments('id').primary();
    // A vehicle belongs to exactly one customer (loyiha.md §12/§31).
    // RESTRICT: a customer referenced by vehicles can never be hard-deleted.
    t.integer('customer_id').unsigned().notNullable().references('id').inTable('customers').onDelete('RESTRICT');
    // Davlat raqami — stored normalized (uppercase, no spaces); global identity
    // for the future §13 "existing vehicle" lookup, hence unique.
    t.string('plate_number', 12).notNullable().unique('uq_vehicles_plate');
    // VIN optional (not always available); unique when present (MySQL allows multiple NULLs).
    t.string('vin', 17).nullable().unique('uq_vehicles_vin');
    t.string('make', 50).notNullable();
    t.string('model', 50).notNullable();
    t.smallint('year').unsigned().nullable();
    t.string('engine', 100).nullable();
    // Latest known mileage (km); per-job mileage snapshots belong to later phases.
    t.integer('mileage').unsigned().nullable();
    t.integer('created_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('deleted_at').nullable();

    t.index(['customer_id'], 'idx_vehicles_customer');
    t.index(['make', 'model'], 'idx_vehicles_make_model');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('vehicles');
}
