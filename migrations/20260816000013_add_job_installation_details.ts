import type { Knex } from 'knex';

/**
 * Installation details per loyiha.md §13: LPG/CNG, kit, ECU, cylinder +
 * "kerakli texnik ma'lumotlar" (free note). They belong to the Job (the
 * service operation), not to the Vehicle identity.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('jobs', (t) => {
    t.string('gas_type', 3).nullable(); // 'LPG' | 'CNG'
    t.string('kit', 100).nullable();
    t.string('ecu', 100).nullable();
    t.string('cylinder', 100).nullable();
    t.string('installation_note', 500).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('jobs', (t) => {
    t.dropColumn('gas_type');
    t.dropColumn('kit');
    t.dropColumn('ecu');
    t.dropColumn('cylinder');
    t.dropColumn('installation_note');
  });
}
