import type { Knex } from 'knex';

/**
 * Photo evidence metadata (loyiha.md §19, §31 "job_photos").
 * Binary data lives in object storage (local provider in development, §40
 * S3/MinIO later) — the database stores metadata + the server-generated
 * storage key only. Photos are immutable evidence: no update/delete surface.
 * `attempt` ties evidence to a specific STOP submission cycle so a rejected
 * attempt's photos are never mixed with the corrected attempt's photos.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('job_photos', (t) => {
    t.increments('id').primary();
    t.integer('job_id').unsigned().notNullable().references('id').inTable('jobs').onDelete('RESTRICT');
    t.integer('job_step_id').unsigned().notNullable().references('id').inTable('job_steps').onDelete('RESTRICT');
    t.integer('attempt').unsigned().notNullable().defaultTo(1);
    // Server-generated key (photos/<job>/<step>/<uuid>.<ext>) — never the client filename.
    t.string('storage_key', 255).notNullable().unique('uq_job_photos_storage_key');
    t.string('original_name', 255).notNullable();
    t.string('mime_type', 50).notNullable();
    t.integer('size_bytes').unsigned().notNullable();
    // SHA-256 of the file content (§19 "hash") — evidence integrity.
    t.string('hash', 64).notNullable();
    t.integer('created_by').unsigned().notNullable().references('id').inTable('users').onDelete('RESTRICT');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    t.index(['job_step_id', 'attempt'], 'idx_job_photos_step_attempt');
    t.index(['job_id'], 'idx_job_photos_job');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('job_photos');
}
