import type { Knex } from 'knex';

/**
 * Phase 10F — tamper-evident audit log.
 *
 * Adds a per-UTC-day hash chain over audit_logs plus:
 *  - `audit_chain_heads`: the current head hash/seq per chain (the lock target
 *    that serializes appends WITHIN a day only — not the whole app).
 *  - `audit_chain_checkpoints`: genesis + exportable checkpoints for off-server
 *    anchoring (a DBA who can rewrite rows AND hashes is only defeated by an
 *    externally-stored checkpoint — documented in BACKUP-RESTORE / AUDIT docs).
 *  - a BEFORE UPDATE trigger that makes existing rows non-modifiable through the
 *    app connection (the app never updates audit rows; deletion is detected by
 *    the chain and prevented in production via restricted GRANTs).
 *
 * LEGACY HONESTY: rows that already exist predate the chain and are NOT
 * retro-chained (that would fabricate integrity). A genesis checkpoint records
 * the legacy boundary (max existing id); chaining begins for rows after it.
 * Reversible.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('audit_logs', (t) => {
    t.string('chain_id', 10).nullable(); // 'YYYY-MM-DD' (UTC) — null for legacy rows
    t.bigInteger('chain_seq').unsigned().nullable(); // monotonic within a chain
    t.specificType('prev_hash', 'char(64)').nullable();
    t.specificType('entry_hash', 'char(64)').nullable();
    t.index(['chain_id', 'chain_seq'], 'idx_audit_chain');
  });

  if (!(await knex.schema.hasTable('audit_chain_heads'))) {
    await knex.schema.createTable('audit_chain_heads', (t) => {
      t.string('chain_id', 10).notNullable().primary();
      t.specificType('head_hash', 'char(64)').notNullable();
      t.bigInteger('head_seq').unsigned().notNullable().defaultTo(0);
      t.datetime('updated_at', { precision: 6 }).notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(6)'));
    });
  }

  if (!(await knex.schema.hasTable('audit_chain_checkpoints'))) {
    await knex.schema.createTable('audit_chain_checkpoints', (t) => {
      t.bigIncrements('id').primary();
      t.string('chain_id', 16).notNullable();
      t.bigInteger('checkpoint_seq').unsigned().notNullable();
      t.specificType('checkpoint_hash', 'char(64)').notNullable();
      t.string('note', 255).nullable();
      t.datetime('created_at', { precision: 6 }).notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(6)'));
      t.index(['chain_id'], 'idx_audit_checkpoint_chain');
    });
  }

  // Genesis checkpoint: record the legacy boundary honestly (no retro-chaining).
  const row = (await knex('audit_logs').max({ maxId: 'id' }).first()) as { maxId: number | null } | undefined;
  const legacyMaxId = Number(row?.maxId ?? 0);
  await knex('audit_chain_checkpoints').insert({
    chain_id: 'genesis',
    checkpoint_seq: legacyMaxId,
    checkpoint_hash: '0'.repeat(64),
    note: `legacy boundary: audit_logs.id <= ${legacyMaxId} predate the hash chain (unchained, origin not cryptographically attested)`,
  });

  // Append-only enforcement at the DB layer: block UPDATEs on audit rows. The app
  // never updates audit_logs; this stops silent in-place content tampering via the
  // app credential. (A superuser can still DROP the trigger — see docs.)
  await knex.raw(`
    CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs
    FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only'
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TRIGGER IF EXISTS audit_logs_no_update');
  await knex.schema.dropTableIfExists('audit_chain_checkpoints');
  await knex.schema.dropTableIfExists('audit_chain_heads');
  await knex.schema.alterTable('audit_logs', (t) => {
    t.dropIndex(['chain_id', 'chain_seq'], 'idx_audit_chain');
    t.dropColumn('chain_id');
    t.dropColumn('chain_seq');
    t.dropColumn('prev_hash');
    t.dropColumn('entry_hash');
  });
}
