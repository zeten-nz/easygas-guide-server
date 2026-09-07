import type { Knex } from 'knex';

/**
 * Manual employee password recovery (product decision: EasyGas is employee-only;
 * SMS/OTP self-service recovery is removed). An ADMIN issues a one-time temporary
 * password; the employee must change it on first login. Two new user columns:
 *
 *   must_change_password    — while true, the session is a "restricted" session:
 *                             the user may ONLY view their restricted session and
 *                             change their password (enforced server-side); all
 *                             business endpoints reject the request.
 *   temp_password_expires_at — when the issued temporary password stops being
 *                             accepted (a configurable window; NULL for a normal
 *                             password). Checked on the authoritative login path.
 *
 * Idempotent column adds so a partially-applied migration can be re-run.
 */
export async function up(knex: Knex): Promise<void> {
  const add: string[] = [];
  if (!(await knex.schema.hasColumn('users', 'must_change_password'))) add.push('must_change_password');
  if (!(await knex.schema.hasColumn('users', 'temp_password_expires_at'))) add.push('temp_password_expires_at');
  if (add.length === 0) return;

  await knex.schema.alterTable('users', (t) => {
    if (add.includes('must_change_password')) t.boolean('must_change_password').notNullable().defaultTo(false);
    if (add.includes('temp_password_expires_at')) t.timestamp('temp_password_expires_at').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const c of ['temp_password_expires_at', 'must_change_password']) {
    if (await knex.schema.hasColumn('users', c)) {
      await knex.schema.alterTable('users', (t) => t.dropColumn(c));
    }
  }
}
