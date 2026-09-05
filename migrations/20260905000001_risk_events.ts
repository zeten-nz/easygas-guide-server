import type { Knex } from 'knex';

/**
 * Phase 10D — risk_events (loyiha.md §31/§21).
 *
 * Server-authoritative, versioned risk records tied to a job + cycle (and
 * optionally a checklist step/attempt). The backend computes score/level/blocking
 * under a matrix_version that is frozen on the row, so future matrix changes
 * never rewrite old classifications. Safety records are never destructively
 * deleted — a correction supersedes (revision chain) and is audited.
 *
 * Reversible: down() drops the table. No backfill (new safety data only).
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('risk_events')) return;
  await knex.schema.createTable('risk_events', (t) => {
    t.bigIncrements('id').primary();
    t.integer('job_id').unsigned().notNullable().references('id').inTable('jobs').onDelete('RESTRICT');
    t.integer('cycle').unsigned().notNullable().defaultTo(1);
    t.integer('job_step_id').unsigned().nullable().references('id').inTable('job_steps').onDelete('SET NULL');
    t.integer('attempt').unsigned().nullable();

    t.string('hazard', 80).notNullable(); // hazard/category type
    t.text('description').notNullable();
    t.integer('severity').unsigned().nullable(); // 1..4 (null for pure source-derived)
    t.integer('likelihood').unsigned().nullable(); // 1..4

    // Backend-computed classification, frozen under a matrix version.
    t.integer('score').unsigned().notNullable();
    t.string('level', 10).notNullable(); // LOW|MEDIUM|HIGH|CRITICAL
    t.boolean('blocking').notNullable().defaultTo(false);
    t.string('matrix_version', 16).notNullable();
    t.string('source', 32).notNullable(); // MANUAL|STOP_REJECTED|MEASUREMENT_OUT_OF_RANGE|CHECKLIST_FLAG

    t.string('status', 24).notNullable().defaultTo('OPEN'); // OPEN|MITIGATION_IN_PROGRESS|RESOLVED|REJECTED
    t.text('mitigation').nullable(); // proposed/approved action

    t.integer('created_by').unsigned().notNullable().references('id').inTable('users').onDelete('RESTRICT');
    t.integer('responsible_user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');

    // Resolution provenance.
    t.integer('resolved_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('resolved_at', { precision: 6 }).nullable();
    t.text('resolution_note').nullable();
    t.integer('resolution_stop_approval_id').unsigned().nullable().references('id').inTable('stop_approvals').onDelete('SET NULL');

    // Revision chain (a correction supersedes rather than mutating history).
    t.bigInteger('supersedes_id').unsigned().nullable();

    t.datetime('created_at', { precision: 6 }).notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(6)'));
    t.datetime('updated_at', { precision: 6 }).notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(6)'));

    t.index(['job_id', 'cycle', 'status'], 'idx_risk_job_cycle_status');
    t.index(['job_id', 'cycle', 'level'], 'idx_risk_job_cycle_level');
    t.index(['job_id', 'cycle', 'blocking', 'status'], 'idx_risk_job_cycle_blocking');
    t.index(['status'], 'idx_risk_status');
    t.index(['responsible_user_id'], 'idx_risk_responsible');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('risk_events');
}
