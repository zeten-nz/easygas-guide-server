import type { Knex } from 'knex';

/**
 * Phase 10F — microsecond precision for safety/audit EVENT timestamps.
 *
 * Phase 1–9 tables used 1-second `TIMESTAMP` columns, so two events in the same
 * second are indistinguishable by time alone. Ordering/race logic already uses
 * the monotonic numeric `id` (and `attempt`/`sort_order`) as the authoritative
 * tie-breaker, so this is DEFENSE-IN-DEPTH, not a correctness fix: it upgrades
 * the columns whose sub-second ORDERING carries safety/audit meaning to
 * `DATETIME(6)`, while numeric ids remain the final tie-breaker.
 *
 * Scope is deliberately narrow (event timestamps only — not every created_at/
 * updated_at) to avoid rewriting unrelated tables. Values are preserved by the
 * in-place MODIFY. Reversible (back to `TIMESTAMP`); existing values are well
 * within the TIMESTAMP range.
 */

// [table, column, nullable, hasDefaultNow]
const EVENT_COLUMNS: Array<[string, string, boolean, boolean]> = [
  ['audit_logs', 'created_at', false, true],
  ['customer_signatures', 'created_at', false, true],
  ['stop_approvals', 'submitted_at', false, true],
  ['stop_approvals', 'decided_at', true, false],
  ['job_steps', 'completed_at', true, false],
];

export async function up(knex: Knex): Promise<void> {
  for (const [table, col, nullable, hasDefaultNow] of EVENT_COLUMNS) {
    const nullSql = nullable ? 'NULL' : 'NOT NULL';
    const def = hasDefaultNow ? ' DEFAULT CURRENT_TIMESTAMP(6)' : '';
    await knex.raw(`ALTER TABLE \`${table}\` MODIFY COLUMN \`${col}\` DATETIME(6) ${nullSql}${def}`);
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const [table, col, nullable, hasDefaultNow] of EVENT_COLUMNS) {
    const nullSql = nullable ? 'NULL' : 'NOT NULL';
    const def = hasDefaultNow ? ' DEFAULT CURRENT_TIMESTAMP' : '';
    await knex.raw(`ALTER TABLE \`${table}\` MODIFY COLUMN \`${col}\` TIMESTAMP ${nullSql}${def}`);
  }
}
