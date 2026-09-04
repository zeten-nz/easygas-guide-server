import type { Knex } from 'knex';

/**
 * Phase 10D — immutable completion snapshot + signable-summary binding.
 *
 *  completion_snapshots: one immutable artifact per successful completion CYCLE
 *    (unique job_id+cycle). Server-built from authoritative rows, canonically
 *    serialized, SHA-256 digested. Never UPDATEd in place (a correction is a new
 *    superseding row + audit). provenance = FINALIZED | LEGACY_RECONSTRUCTED.
 *
 *  customer_signatures: gains the signable-summary digest the customer actually
 *    accepted (summary_digest) + its schema version, so completion can reject a
 *    signature that no longer matches the current work summary.
 *
 * Reversible. No destructive backfill.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('completion_snapshots'))) {
    await knex.schema.createTable('completion_snapshots', (t) => {
      t.bigIncrements('id').primary();
      t.integer('job_id').unsigned().notNullable().references('id').inTable('jobs').onDelete('RESTRICT');
      t.integer('cycle').unsigned().notNullable();
      t.string('schema_version', 20).notNullable();
      t.string('provenance', 24).notNullable().defaultTo('FINALIZED'); // FINALIZED | LEGACY_RECONSTRUCTED
      // Canonical serialized content (the exact bytes the digest was taken over).
      t.text('content', 'mediumtext').notNullable();
      t.string('digest', 64).notNullable(); // sha256 hex of content
      // The signable-summary digest + signature image hash bound into this cycle.
      t.string('summary_digest', 64).nullable();
      t.string('signature_hash', 64).nullable();
      t.integer('finalized_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
      // A superseding correction points back to the row it replaces (never delete).
      t.bigInteger('supersedes_id').unsigned().nullable();
      t.datetime('created_at', { precision: 6 }).notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(6)'));
      t.unique(['job_id', 'cycle'], 'uq_completion_snapshot_job_cycle');
      t.index(['job_id'], 'idx_completion_snapshot_job');
      t.index(['digest'], 'idx_completion_snapshot_digest');
    });
  }

  if (!(await knex.schema.hasColumn('customer_signatures', 'summary_digest'))) {
    await knex.schema.alterTable('customer_signatures', (t) => {
      t.string('summary_digest', 64).nullable();
      t.string('summary_schema_version', 20).nullable();
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('completion_snapshots');
  if (await knex.schema.hasColumn('customer_signatures', 'summary_digest')) {
    await knex.schema.alterTable('customer_signatures', (t) => {
      t.dropColumn('summary_digest');
      t.dropColumn('summary_schema_version');
    });
  }
}
