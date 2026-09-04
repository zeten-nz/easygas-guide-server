import type { Knex } from 'knex';

/**
 * §3 correction cycles: every STOP resubmission is a new attempt. Historical
 * evidence (measured values) of a rejected attempt must survive the corrected
 * resubmission, so measurements become attempt-scoped:
 * unique (job_step, measurement) → unique (job_step, measurement, attempt).
 * stop_approvals also records which attempt it decided. Existing rows are all
 * attempt 1 (no reworks could have happened before this migration).
 *
 * Ordering matters (MySQL DDL is non-transactional): the NEW unique index is
 * created BEFORE the old one is dropped, because the job_step_id FK needs at
 * least one index starting with job_step_id at all times. hasColumn guards
 * make the migration safe to re-run after a partial failure.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('stop_approvals', 'attempt'))) {
    await knex.schema.alterTable('stop_approvals', (t) => {
      t.integer('attempt').unsigned().notNullable().defaultTo(1);
    });
  }
  if (!(await knex.schema.hasColumn('step_measurements', 'attempt'))) {
    await knex.schema.alterTable('step_measurements', (t) => {
      t.integer('attempt').unsigned().notNullable().defaultTo(1);
    });
  }
  // New attempt-scoped unique first (also serves the job_step_id FK)…
  await knex.schema.alterTable('step_measurements', (t) => {
    t.unique(['job_step_id', 'measurement_id', 'attempt'], 'uq_step_measurements_attempt');
  });
  // …then the old two-column unique can be dropped safely.
  await knex.schema.alterTable('step_measurements', (t) => {
    t.dropUnique([], 'uq_step_measurements_job_step_measurement');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('step_measurements', (t) => {
    t.unique(['job_step_id', 'measurement_id'], 'uq_step_measurements_job_step_measurement');
  });
  await knex.schema.alterTable('step_measurements', (t) => {
    t.dropUnique([], 'uq_step_measurements_attempt');
  });
  await knex.schema.alterTable('step_measurements', (t) => {
    t.dropColumn('attempt');
  });
  await knex.schema.alterTable('stop_approvals', (t) => {
    t.dropColumn('attempt');
  });
}
