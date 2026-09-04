import type { Knex } from 'knex';

/** Initial reference branches — managed by Admin in later phases. */
const BRANCHES = [
  { name: 'EASY GAS Chilonzor', region: 'Toshkent shahri', address: 'Toshkent, Chilonzor tumani', status: 'ACTIVE' },
  { name: 'EASY GAS Yunusobod', region: 'Toshkent shahri', address: 'Toshkent, Yunusobod tumani', status: 'ACTIVE' },
  { name: 'EASY GAS Samarqand', region: 'Samarqand', address: 'Samarqand shahri', status: 'ACTIVE' },
];

export async function seed(knex: Knex): Promise<void> {
  for (const branch of BRANCHES) {
    const exists = await knex('branches').where({ name: branch.name }).first();
    if (!exists) {
      await knex('branches').insert(branch);
    }
  }
}
