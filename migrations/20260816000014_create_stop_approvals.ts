import type { Knex } from 'knex';

/**
 * STOP approval records (loyiha.md §17–18, §31 "stop_approvals").
 * Every STOP submission creates a new historical row — decisions are never
 * overwritten or deleted. At most one PENDING row can exist per job, enforced
 * by the state machine (a submission moves the job out of IN_PROGRESS, which
 * blocks further submissions) plus row locks — not by a DB constraint
 * (MySQL has no partial unique indexes).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('stop_approvals', (t) => {
    t.increments('id').primary();
    t.integer('job_id').unsigned().notNullable().references('id').inTable('jobs').onDelete('RESTRICT');
    t.integer('job_step_id').unsigned().notNullable().references('id').inTable('job_steps').onDelete('RESTRICT');
    // PENDING → APPROVED | REJECTED (final — history, never mutated afterwards)
    t.string('status', 20).notNullable().defaultTo('PENDING');
    t.integer('submitted_by').unsigned().notNullable().references('id').inTable('users').onDelete('RESTRICT');
    t.timestamp('submitted_at').notNullable().defaultTo(knex.fn.now());
    t.integer('decided_by').unsigned().nullable().references('id').inTable('users').onDelete('RESTRICT');
    t.timestamp('decided_at').nullable();
    t.string('reject_reason', 500).nullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    t.index(['job_id', 'status'], 'idx_stop_approvals_job_status');
    t.index(['job_step_id'], 'idx_stop_approvals_job_step');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('stop_approvals');
}
