import type { Knex } from 'knex';

const ROLES = [
  { code: 'USTA', name: 'Service ustasi' },
  { code: 'MASTER', name: 'Service masteri' },
  { code: 'RAHBAR', name: 'Service rahbari' },
  { code: 'SIFAT', name: 'Sifat nazorati' },
  { code: 'ADMIN', name: 'Administrator' },
];

export async function seed(knex: Knex): Promise<void> {
  for (const role of ROLES) {
    const exists = await knex('roles').where({ code: role.code }).first();
    if (!exists) {
      await knex('roles').insert(role);
    }
  }
}
