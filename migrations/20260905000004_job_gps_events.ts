import type { Knex } from 'knex';

/**
 * Phase 10D — GPS evidence (loyiha.md §20: captured at installation).
 *
 * Client-REPORTED location evidence, never treated as tamper-proof proof of
 * physical presence. Stores the client-captured coordinate + accuracy + client
 * timestamp AND the server receipt time, bound to a job + cycle + actor +
 * purpose, with a validation/provenance status. An authorized override (reason)
 * is recorded when acceptable GPS is unavailable. No continuous tracking.
 *
 * Reversible; no backfill (new evidence only).
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('job_gps_events')) return;
  await knex.schema.createTable('job_gps_events', (t) => {
    t.bigIncrements('id').primary();
    t.integer('job_id').unsigned().notNullable().references('id').inTable('jobs').onDelete('RESTRICT');
    t.integer('cycle').unsigned().notNullable().defaultTo(1);
    t.integer('actor_id').unsigned().notNullable().references('id').inTable('users').onDelete('RESTRICT');
    t.string('purpose', 32).notNullable(); // JOB_START | CHECKLIST_COMPLETE | CUSTOMER_SIGNATURE | JOB_COMPLETE | RISK_STOP_EVENT
    t.decimal('latitude', 9, 6).nullable();
    t.decimal('longitude', 9, 6).nullable();
    t.decimal('accuracy_m', 8, 2).nullable();
    t.datetime('client_timestamp', { precision: 3 }).nullable();
    t.datetime('server_received_at', { precision: 3 }).notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));
    t.string('source', 24).notNullable().defaultTo('BROWSER_GEOLOCATION');
    // VALIDATED (client-reported, passed policy) | OVERRIDE (unavailable, authorized)
    t.string('provenance', 16).notNullable();
    t.text('override_reason').nullable();
    t.integer('override_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('created_at', { precision: 6 }).notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(6)'));
    t.index(['job_id', 'cycle', 'purpose'], 'idx_gps_job_cycle_purpose');
    t.index(['actor_id'], 'idx_gps_actor');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('job_gps_events');
}
