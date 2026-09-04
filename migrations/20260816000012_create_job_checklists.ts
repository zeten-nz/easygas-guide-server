import type { Knex } from 'knex';

/**
 * Execution side (loyiha.md §15, §31: job_steps + step_measurements).
 * A job gets exactly one checklist bound to a CONCRETE template version
 * (never "current active" dynamically — §41 historical integrity).
 * All execution rows are created at assignment time and are never deleted.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('job_checklists', (t) => {
    t.increments('id').primary();
    t.integer('job_id').unsigned().notNullable().references('id').inTable('jobs').onDelete('RESTRICT').unique('uq_job_checklists_job');
    t.integer('version_id').unsigned().notNullable().references('id').inTable('checklist_template_versions').onDelete('RESTRICT');
    t.integer('assigned_by').unsigned().notNullable().references('id').inTable('users').onDelete('RESTRICT');
    t.timestamp('assigned_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('completed_at').nullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    t.index(['version_id'], 'idx_job_checklists_version');
  });

  // One execution row per template step (§31 job_steps). Status is a string
  // because §17 later adds WAITING_APPROVAL/APPROVED/REJECTED for STOP steps.
  await knex.schema.createTable('job_steps', (t) => {
    t.increments('id').primary();
    t.integer('job_checklist_id').unsigned().notNullable().references('id').inTable('job_checklists').onDelete('RESTRICT');
    t.integer('step_id').unsigned().notNullable().references('id').inTable('checklist_steps').onDelete('RESTRICT');
    t.string('status', 30).notNullable().defaultTo('PENDING');
    t.string('note', 1000).nullable();
    t.integer('completed_by').unsigned().nullable().references('id').inTable('users').onDelete('RESTRICT');
    t.timestamp('completed_at').nullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    t.unique(['job_checklist_id', 'step_id'], 'uq_job_steps_checklist_step');
    t.index(['job_checklist_id', 'status'], 'idx_job_steps_checklist_status');
  });

  // ACTUAL measured values (§16/§31 step_measurements) — what really happened,
  // stored separately from the template's expected rule. is_within_range is
  // the validation-result snapshot at submission time.
  await knex.schema.createTable('step_measurements', (t) => {
    t.increments('id').primary();
    t.integer('job_step_id').unsigned().notNullable().references('id').inTable('job_steps').onDelete('RESTRICT');
    t.integer('measurement_id').unsigned().notNullable().references('id').inTable('checklist_step_measurements').onDelete('RESTRICT');
    t.decimal('value', 12, 3).notNullable();
    t.boolean('is_within_range').notNullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    t.unique(['job_step_id', 'measurement_id'], 'uq_step_measurements_job_step_measurement');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('step_measurements');
  await knex.schema.dropTableIfExists('job_steps');
  await knex.schema.dropTableIfExists('job_checklists');
}
