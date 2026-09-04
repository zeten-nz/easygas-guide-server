import type { Knex } from 'knex';

/**
 * Phase 10B — evidence & object-storage integrity.
 *
 * Adds an explicit persisted lifecycle to every mandatory evidence file so
 * that completion gates count only evidence whose object has actually been
 * stored and verified:
 *
 *   PENDING    — metadata registered, object write not yet confirmed
 *   UNVERIFIED — pre-Phase-10B legacy row, never checked against storage
 *   READY      — object written AND verified against its metadata (only this counts)
 *   FAILED     — write failed, superseded, or reconciliation found it corrupt
 *
 * Signatures additionally gain a `cycle` (the reopen cycle they belong to) and
 * lose the one-per-job UNIQUE constraint, so a reopened job requires a fresh
 * READY signature for the new cycle while old signatures remain in history.
 *
 * LEGACY BACKFILL POLICY (documented): a pre-existing DB row is NOT proof that
 * its object is present, whole, and matches its recorded size/sha256 — the file
 * may be missing, truncated, or altered. So every pre-existing evidence row is
 * backfilled to UNVERIFIED (a NON-valid state that can never satisfy a
 * completion gate — those count only READY), NOT to READY. `ready_at` is left
 * null so provenance is unambiguous from the status column alone: UNVERIFIED =
 * legacy/never-verified, PENDING = a Phase 10B upload in flight, READY = an
 * object actually verified. Only a successful deep verification promotes a
 * legacy row: run `npm run reconcile -- --apply --deep`, which reads each
 * object, recomputes sha256, compares size + hash (+ detected type), and
 * transitions UNVERIFIED -> READY on a match or -> FAILED when the object is
 * missing/altered. The stale-PENDING sweep never touches UNVERIFIED rows, so
 * legacy evidence is not auto-failed by the age window; it waits for an
 * explicit verification run.
 *
 * MySQL notes (DDL is non-transactional): column additions are hasColumn-
 * guarded so a partially-applied migration can be re-run; and the replacement
 * index for customer_signatures.job_id is created BEFORE the old UNIQUE is
 * dropped, because that unique index backs the job_id foreign key.
 */
export async function up(knex: Knex): Promise<void> {
  // --- job_photos: lifecycle columns ---
  await addColumns(knex, 'job_photos', (t) => {
    t.string('status', 12).notNullable().defaultTo('PENDING');
    t.string('content_type', 50).nullable();
    t.timestamp('ready_at').nullable();
    t.timestamp('failed_at').nullable();
    t.string('failure_reason', 60).nullable();
  }, ['status', 'content_type', 'ready_at', 'failed_at', 'failure_reason']);
  // Legacy rows -> UNVERIFIED (never READY): existence and integrity are unknown
  // until a deep reconciliation run verifies each object. UNVERIFIED never
  // satisfies a completion gate. See the LEGACY BACKFILL POLICY above.
  await knex('job_photos').where({ status: 'PENDING' }).update({ status: 'UNVERIFIED' });
  await ensureIndex(knex, 'job_photos', ['job_step_id', 'attempt', 'status'], 'idx_job_photos_step_attempt_status');
  await ensureIndex(knex, 'job_photos', ['status'], 'idx_job_photos_status');

  // --- jobs: completion cycle ---
  await addColumns(knex, 'jobs', (t) => {
    t.integer('cycle').unsigned().notNullable().defaultTo(1);
  }, ['cycle']);
  await knex('jobs').whereNotNull('reopened_at').where({ cycle: 1 }).update({ cycle: 2 });

  // --- customer_signatures: lifecycle + cycle ---
  await addColumns(knex, 'customer_signatures', (t) => {
    t.string('status', 12).notNullable().defaultTo('PENDING');
    t.integer('cycle').unsigned().notNullable().defaultTo(1);
    t.string('content_type', 50).nullable();
    t.timestamp('ready_at').nullable();
    t.timestamp('failed_at').nullable();
    t.string('failure_reason', 60).nullable();
    t.timestamp('superseded_at').nullable();
  }, ['status', 'cycle', 'content_type', 'ready_at', 'failed_at', 'failure_reason', 'superseded_at']);
  // Legacy signatures -> UNVERIFIED (never READY) for the same reason as photos:
  // a row is not proof the signature image is present and unaltered.
  await knex('customer_signatures').where({ status: 'PENDING' }).update({ status: 'UNVERIFIED' });

  // New indexes FIRST — idx_...job_cycle_status starts with job_id, so it can
  // back the job_id FK once the old UNIQUE is dropped.
  await ensureIndex(knex, 'customer_signatures', ['job_id', 'cycle', 'status'], 'idx_customer_signatures_job_cycle_status');
  await ensureIndex(knex, 'customer_signatures', ['status'], 'idx_customer_signatures_status');
  // Now the one-per-job UNIQUE can go (service enforces one READY per cycle).
  if (await indexExists(knex, 'customer_signatures', 'uq_customer_signatures_job')) {
    await knex.schema.alterTable('customer_signatures', (t) => t.dropUnique(['job_id'], 'uq_customer_signatures_job'));
  }
}

export async function down(knex: Knex): Promise<void> {
  // Restore the one-signature-per-job UNIQUE: keep only the newest row per job.
  await knex.raw(`
    DELETE cs FROM customer_signatures cs
    JOIN (SELECT job_id, MAX(id) AS keep_id FROM customer_signatures GROUP BY job_id) m
      ON m.job_id = cs.job_id AND cs.id <> m.keep_id
  `);
  if (!(await indexExists(knex, 'customer_signatures', 'uq_customer_signatures_job'))) {
    await knex.schema.alterTable('customer_signatures', (t) => t.unique(['job_id'], 'uq_customer_signatures_job'));
  }
  await dropIndex(knex, 'customer_signatures', 'idx_customer_signatures_job_cycle_status');
  await dropIndex(knex, 'customer_signatures', 'idx_customer_signatures_status');
  await dropColumns(knex, 'customer_signatures', [
    'status',
    'cycle',
    'content_type',
    'ready_at',
    'failed_at',
    'failure_reason',
    'superseded_at',
  ]);

  await dropColumns(knex, 'jobs', ['cycle']);

  await dropIndex(knex, 'job_photos', 'idx_job_photos_step_attempt_status');
  await dropIndex(knex, 'job_photos', 'idx_job_photos_status');
  await dropColumns(knex, 'job_photos', ['status', 'content_type', 'ready_at', 'failed_at', 'failure_reason']);
}

// --- idempotent DDL helpers (MySQL DDL is non-transactional) ---

async function addColumns(
  knex: Knex,
  table: string,
  build: (t: Knex.CreateTableBuilder) => void,
  cols: string[],
): Promise<void> {
  const missing = [];
  for (const c of cols) if (!(await knex.schema.hasColumn(table, c))) missing.push(c);
  if (missing.length === 0) return;
  await knex.schema.alterTable(table, build);
}

async function dropColumns(knex: Knex, table: string, cols: string[]): Promise<void> {
  for (const c of cols) {
    if (await knex.schema.hasColumn(table, c)) {
      await knex.schema.alterTable(table, (t) => t.dropColumn(c));
    }
  }
}

async function indexExists(knex: Knex, table: string, name: string): Promise<boolean> {
  const rows = (await knex.raw('SHOW INDEX FROM ?? WHERE Key_name = ?', [table, name])) as [unknown[], unknown];
  return rows[0].length > 0;
}

async function ensureIndex(knex: Knex, table: string, cols: string[], name: string): Promise<void> {
  if (!(await indexExists(knex, table, name))) {
    await knex.schema.alterTable(table, (t) => t.index(cols, name));
  }
}

async function dropIndex(knex: Knex, table: string, name: string): Promise<void> {
  if (await indexExists(knex, table, name)) {
    await knex.schema.alterTable(table, (t) => t.dropIndex([], name));
  }
}
