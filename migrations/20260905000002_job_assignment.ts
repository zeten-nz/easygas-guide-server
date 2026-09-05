import type { Knex } from 'knex';

/**
 * Phase 10D — explicit job assignment & responsibility (loyiha.md §12 Job joins
 * a Technician). Adds the current responsible technician to `jobs` and an
 * immutable `job_assignments` history (every assign/reassign/unassign is a new
 * row; the current pointer is denormalized onto jobs for fast filtering).
 *
 * Legacy jobs (created before 10D) are NOT guessed a technician: they are left
 * assigned_technician_id = NULL, assignment_status = 'LEGACY_UNASSIGNED'
 * (created_by is deliberately NOT assumed to be the responsible technician).
 * Reversible; the backfill only sets the provenance marker, never invents data.
 */
export async function up(knex: Knex): Promise<void> {
  const hasCol = await knex.schema.hasColumn('jobs', 'assigned_technician_id');
  if (!hasCol) {
    await knex.schema.alterTable('jobs', (t) => {
      t.integer('assigned_technician_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
      t.string('assignment_status', 24).notNullable().defaultTo('UNASSIGNED'); // UNASSIGNED|ASSIGNED|LEGACY_UNASSIGNED
      t.index(['assigned_technician_id', 'status'], 'idx_jobs_assignee_status');
    });
    // Pre-10D rows: mark provenance explicitly (do not guess a technician).
    await knex('jobs').update({ assignment_status: 'LEGACY_UNASSIGNED' });
  }

  if (!(await knex.schema.hasTable('job_assignments'))) {
    await knex.schema.createTable('job_assignments', (t) => {
      t.bigIncrements('id').primary();
      t.integer('job_id').unsigned().notNullable().references('id').inTable('jobs').onDelete('RESTRICT');
      t.integer('cycle').unsigned().notNullable().defaultTo(1);
      // NULL technician = an UNASSIGN event.
      t.integer('technician_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
      t.integer('assigned_by').unsigned().notNullable().references('id').inTable('users').onDelete('RESTRICT');
      // SELF_AT_CREATION | REASSIGNED | UNASSIGNED | SUPERVISOR_OVERRIDE
      t.string('provenance', 32).notNullable();
      t.text('reason').nullable();
      t.datetime('created_at', { precision: 6 }).notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(6)'));
      t.index(['job_id', 'created_at'], 'idx_job_assign_job');
      t.index(['technician_id'], 'idx_job_assign_tech');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('job_assignments');
  if (await knex.schema.hasColumn('jobs', 'assigned_technician_id')) {
    // MySQL cannot drop a column while its FK/index still exist — drop those
    // first (each in its own guarded step), then the columns.
    await knex.schema.alterTable('jobs', (t) => t.dropForeign(['assigned_technician_id']));
    await knex.schema.alterTable('jobs', (t) => t.dropIndex(['assigned_technician_id', 'status'], 'idx_jobs_assignee_status'));
    await knex.schema.alterTable('jobs', (t) => {
      t.dropColumn('assigned_technician_id');
      t.dropColumn('assignment_status');
    });
  }
}
