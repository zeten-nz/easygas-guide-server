import type { Knex } from 'knex';

/**
 * Phase 10E acceptance correction — make "exactly one ACTIVE risk matrix" a
 * hard, race-proof invariant.
 *
 * The Phase 10D activation path serialized concurrent activations by locking
 * every matrix row (`SELECT * ... FOR UPDATE`). A full-table scan lock relies on
 * the rows that happen to exist and, under load, can interleave into deadlocks /
 * lock-wait nondeterminism — so a concurrent activation could return a non-200
 * even though the invariant held. This migration replaces that with two robust,
 * layered mechanisms:
 *
 *  1) `risk_policy_control` — a PERMANENT singleton row (id=1). Activation and
 *     retirement take `SELECT ... FOR UPDATE` on this single always-present row,
 *     serializing deterministically without scanning/locking a variable set of
 *     rows (no gap locks, no deadlock cycle, no "lock a row that may not exist").
 *
 *  2) A UNIQUE index over a virtual generated column that is `1` only while a row
 *     is ACTIVE (NULL otherwise). MySQL allows repeated NULLs but rejects a second
 *     `1`, so the database itself makes more than one ACTIVE matrix impossible —
 *     a safety net independent of application code.
 *
 * Reversible. Defensive: any pre-existing (invalid) multi-ACTIVE state is reduced
 * to the newest ACTIVE before the unique index is added, so the migration applies
 * cleanly on any historical database. Existing versions/approvals are preserved.
 */
export async function up(knex: Knex): Promise<void> {
  // 1) Permanent singleton control row for activation serialization.
  if (!(await knex.schema.hasTable('risk_policy_control'))) {
    await knex.schema.createTable('risk_policy_control', (t) => {
      t.tinyint('id').unsigned().notNullable().primary();
      t.string('note', 96).nullable();
      t.datetime('updated_at', { precision: 6 }).notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(6)'));
    });
  }
  await knex.raw(
    "INSERT INTO risk_policy_control (id, note) VALUES (1, 'risk-policy activate/retire serialization singleton') ON DUPLICATE KEY UPDATE id = id",
  );

  // 2) Database-enforced one-ACTIVE invariant.
  if (await knex.schema.hasColumn('risk_matrix_versions', 'active_flag')) return; // already applied

  // Defensively collapse any pre-existing multi-ACTIVE state (keep the newest id)
  // so the UNIQUE index below can be created on every historical database.
  await knex.raw(
    `UPDATE risk_matrix_versions r
       JOIN (SELECT MAX(id) AS keep_id FROM risk_matrix_versions WHERE status = 'ACTIVE') m
        SET r.status = 'RETIRED'
      WHERE r.status = 'ACTIVE' AND r.id <> m.keep_id`,
  );

  // Virtual generated column: 1 while ACTIVE, NULL otherwise.
  await knex.raw(
    "ALTER TABLE risk_matrix_versions ADD COLUMN active_flag TINYINT UNSIGNED GENERATED ALWAYS AS (IF(status = 'ACTIVE', 1, NULL)) VIRTUAL",
  );
  // At most one row may carry active_flag = 1 (NULLs do not collide in MySQL).
  await knex.raw('CREATE UNIQUE INDEX uq_risk_matrix_one_active ON risk_matrix_versions (active_flag)');
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('risk_matrix_versions', 'active_flag')) {
    await knex.raw('DROP INDEX uq_risk_matrix_one_active ON risk_matrix_versions');
    await knex.raw('ALTER TABLE risk_matrix_versions DROP COLUMN active_flag');
  }
  await knex.schema.dropTableIfExists('risk_policy_control');
}
