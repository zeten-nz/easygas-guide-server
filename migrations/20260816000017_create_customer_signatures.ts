import type { Knex } from 'knex';

/**
 * Customer signature artifacts (loyiha.md §23, §31 "customer_signatures").
 * The signature is REAL evidence — an image in object storage referenced by a
 * server-generated key — never a client-controlled boolean. One signature per
 * job (unique job_id), immutable once stored (no update/delete surface).
 * jobs also gain closed_by/closed_at for the §22 Master close.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('customer_signatures', (t) => {
    t.increments('id').primary();
    t.integer('job_id').unsigned().notNullable().references('id').inTable('jobs').onDelete('RESTRICT').unique('uq_customer_signatures_job');
    t.integer('customer_id').unsigned().notNullable().references('id').inTable('customers').onDelete('RESTRICT');
    t.string('storage_key', 255).notNullable().unique('uq_customer_signatures_storage_key');
    t.string('mime_type', 50).notNullable();
    t.integer('size_bytes').unsigned().notNullable();
    t.string('hash', 64).notNullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.alterTable('jobs', (t) => {
    t.integer('closed_by').unsigned().nullable().references('id').inTable('users').onDelete('RESTRICT');
    t.timestamp('closed_at').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('jobs', (t) => {
    t.dropForeign(['closed_by']);
    t.dropColumn('closed_by');
    t.dropColumn('closed_at');
  });
  await knex.schema.dropTableIfExists('customer_signatures');
}
