import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('jobs', (t) => {
    // The id doubles as the business job number (loyiha.md defines no separate
    // numbering scheme; project convention is used — displayed as #<id>).
    t.increments('id').primary();
    // Core identity — immutable after creation, all RESTRICT: a job must never
    // become orphaned and its referenced records must never be hard-deleted.
    t.integer('customer_id').unsigned().notNullable().references('id').inTable('customers').onDelete('RESTRICT');
    t.integer('vehicle_id').unsigned().notNullable().references('id').inTable('vehicles').onDelete('RESTRICT');
    t.integer('branch_id').unsigned().notNullable().references('id').inTable('branches').onDelete('RESTRICT');
    t.integer('created_by').unsigned().notNullable().references('id').inTable('users').onDelete('RESTRICT');
    // Full status set per loyiha.md §12; Phase 4 transitions cover only
    // DRAFT→IN_PROGRESS and DRAFT/IN_PROGRESS→CANCELLED (later phases own the rest).
    t.string('status', 30).notNullable().defaultTo('DRAFT');
    t.timestamp('started_at').nullable();
    t.string('cancel_reason', 500).nullable();
    t.integer('cancelled_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('cancelled_at').nullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    // Deliberately NO deleted_at: jobs are service history and are never deleted.

    t.index(['status'], 'idx_jobs_status');
    t.index(['branch_id', 'status'], 'idx_jobs_branch_status');
    t.index(['vehicle_id'], 'idx_jobs_vehicle');
    t.index(['customer_id'], 'idx_jobs_customer');
    t.index(['created_by'], 'idx_jobs_created_by');
    t.index(['created_at'], 'idx_jobs_created_at');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('jobs');
}
