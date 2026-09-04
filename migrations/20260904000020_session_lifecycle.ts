import type { Knex } from 'knex';

/**
 * Phase 10C — server-side session lifecycle.
 *
 * Replaces the single long-lived session with an absolute cap + idle timeout +
 * periodic token rotation. New columns:
 *
 *   absolute_expires_at — hard lifetime cap (a session never lives past this)
 *   family_id           — all rotations of one login share a family; a confirmed
 *                         replay of a rotated-out token revokes the whole family
 *   rotated_to_id       — successor session once this token has been rotated out
 *   superseded_at       — when this token was rotated out (start of grace window)
 *   rotation_seq        — monotonic per-family counter, drives client CSRF ordering
 *
 * The existing `expires_at` is retained as the idle/absolute cap for old rows;
 * `last_used_at` (already present) drives the idle timeout. Idempotent column
 * adds so a partially-applied migration can be re-run.
 */
export async function up(knex: Knex): Promise<void> {
  const cols = ['absolute_expires_at', 'family_id', 'rotated_to_id', 'superseded_at', 'rotation_seq'];
  const missing: string[] = [];
  for (const c of cols) if (!(await knex.schema.hasColumn('sessions', c))) missing.push(c);

  if (missing.length > 0) {
    await knex.schema.alterTable('sessions', (t) => {
      t.timestamp('absolute_expires_at').nullable();
      t.uuid('family_id').nullable();
      t.uuid('rotated_to_id').nullable();
      t.timestamp('superseded_at').nullable();
      t.integer('rotation_seq').unsigned().notNullable().defaultTo(0);
    });
  }

  // Backfill existing rows: their absolute cap is their current expiry, and each
  // is its own family root (no rotation has happened).
  await knex('sessions').whereNull('absolute_expires_at').update({ absolute_expires_at: knex.ref('expires_at') });
  await knex('sessions').whereNull('family_id').update({ family_id: knex.ref('id') });

  // Now enforce NOT NULL on the backfilled columns.
  await knex.schema.alterTable('sessions', (t) => {
    t.timestamp('absolute_expires_at').notNullable().alter();
    t.uuid('family_id').notNullable().alter();
  });

  await ensureIndex(knex, 'sessions', ['family_id'], 'idx_sessions_family');
  await ensureIndex(knex, 'sessions', ['absolute_expires_at'], 'idx_sessions_absolute_expires');
}

export async function down(knex: Knex): Promise<void> {
  await dropIndex(knex, 'sessions', 'idx_sessions_family');
  await dropIndex(knex, 'sessions', 'idx_sessions_absolute_expires');
  for (const c of ['absolute_expires_at', 'family_id', 'rotated_to_id', 'superseded_at', 'rotation_seq']) {
    if (await knex.schema.hasColumn('sessions', c)) {
      await knex.schema.alterTable('sessions', (t) => t.dropColumn(c));
    }
  }
}

async function indexExists(knex: Knex, table: string, name: string): Promise<boolean> {
  const rows = (await knex.raw('SHOW INDEX FROM ?? WHERE Key_name = ?', [table, name])) as [unknown[], unknown];
  return rows[0].length > 0;
}
async function ensureIndex(knex: Knex, table: string, colsList: string[], name: string): Promise<void> {
  if (!(await indexExists(knex, table, name))) {
    await knex.schema.alterTable(table, (t) => t.index(colsList, name));
  }
}
async function dropIndex(knex: Knex, table: string, name: string): Promise<void> {
  if (await indexExists(knex, table, name)) {
    await knex.schema.alterTable(table, (t) => t.dropIndex([], name));
  }
}
