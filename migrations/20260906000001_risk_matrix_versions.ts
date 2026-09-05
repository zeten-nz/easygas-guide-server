import type { Knex } from 'knex';

/**
 * Phase 10D acceptance correction — risk-matrix GOVERNANCE (loyiha.md §21).
 *
 * The v1 thresholds were chosen during implementation and must NOT silently
 * become approved company safety policy. This table gives every matrix an
 * explicit governance lifecycle: DRAFT → ACTIVE → RETIRED, an immutable
 * definition, and an approval record (approved_by/at/rationale). Existing
 * risk_events keep their own stored version/score/level/blocking — changing the
 * active matrix never rewrites history.
 *
 * v1 is SEEDED as DRAFT/UNAPPROVED. It is deliberately NOT auto-approved by this
 * migration — activation requires an authorized approver + rationale (via the
 * API or the bootstrap CLI). Reversible; the seed is the only data written.
 */
const V1_DEFINITION = {
  algorithm: 'severity_x_likelihood',
  allowedSeverity: [1, 2, 3, 4],
  allowedLikelihood: [1, 2, 3, 4],
  // Descending; first match wins. score = severity × likelihood (1..16).
  thresholds: [
    { min: 12, level: 'CRITICAL' },
    { min: 8, level: 'HIGH' },
    { min: 4, level: 'MEDIUM' },
    { min: 0, level: 'LOW' },
  ],
  blockingLevels: ['CRITICAL'],
  sourceOverrides: { STOP_REJECTED: 'CRITICAL' },
  severity4MinLevel: 'HIGH',
};

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('risk_matrix_versions'))) {
    await knex.schema.createTable('risk_matrix_versions', (t) => {
      t.bigIncrements('id').primary();
      t.string('version', 32).notNullable().unique('uq_risk_matrix_version');
      t.text('definition').notNullable(); // immutable JSON after activation
      t.string('status', 12).notNullable().defaultTo('DRAFT'); // DRAFT | ACTIVE | RETIRED
      t.integer('approved_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
      t.datetime('approved_at', { precision: 6 }).nullable();
      t.text('rationale').nullable(); // approval rationale / reference — required to activate
      t.bigInteger('superseded_by').unsigned().nullable();
      t.datetime('created_at', { precision: 6 }).notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(6)'));
      t.index(['status'], 'idx_risk_matrix_status');
    });
  }

  // Seed v1 as DRAFT (unapproved) if not already present — no auto-approval.
  const existing = await knex('risk_matrix_versions').where({ version: 'v1' }).first();
  if (!existing) {
    await knex('risk_matrix_versions').insert({ version: 'v1', definition: JSON.stringify(V1_DEFINITION), status: 'DRAFT' });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('risk_matrix_versions');
}
