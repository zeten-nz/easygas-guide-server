import type { Knex } from 'knex';

/**
 * §24 reopen: jobs carry the latest reopen metadata (reason/actor/timestamp —
 * exact spec fields); full completion history lives in the audit log (both
 * JOB_CLOSED events are preserved there — no second history mechanism).
 *
 * §24 correction: attempts become a first-class column on job_steps (was
 * derived from stop_approvals counts, which only worked for STOP steps).
 * Backfill reproduces the previous derivation exactly: PENDING steps are on
 * attempt (approvals+1); decided/completed steps on max(approvals, 1).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('jobs', (t) => {
    t.string('reopen_reason', 500).nullable();
    t.integer('reopened_by').unsigned().nullable().references('id').inTable('users').onDelete('RESTRICT');
    t.timestamp('reopened_at').nullable();
  });

  await knex.schema.alterTable('job_steps', (t) => {
    t.integer('attempt').unsigned().notNullable().defaultTo(1);
  });

  await knex.raw(`
    UPDATE job_steps js
    LEFT JOIN (
      SELECT job_step_id, COUNT(*) AS c FROM stop_approvals GROUP BY job_step_id
    ) a ON a.job_step_id = js.id
    SET js.attempt = CASE
      WHEN js.status = 'PENDING' THEN COALESCE(a.c, 0) + 1
      ELSE GREATEST(COALESCE(a.c, 0), 1)
    END
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('job_steps', (t) => {
    t.dropColumn('attempt');
  });
  await knex.schema.alterTable('jobs', (t) => {
    t.dropForeign(['reopened_by']);
    t.dropColumn('reopen_reason');
    t.dropColumn('reopened_by');
    t.dropColumn('reopened_at');
  });
}
