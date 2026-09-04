import bcrypt from 'bcrypt';
import type { Knex } from 'knex';

/**
 * Seeds the initial administrator account from environment variables.
 * ADMIN_PHONE and ADMIN_PASSWORD must be set (see .env.example) — nothing is
 * hardcoded here. Skips silently if the admin already exists.
 */
export async function seed(knex: Knex): Promise<void> {
  const phone = process.env.ADMIN_PHONE;
  const password = process.env.ADMIN_PASSWORD;

  if (!phone || !password) {
    // eslint-disable-next-line no-console
    console.warn('[seed] ADMIN_PHONE / ADMIN_PASSWORD not set — skipping admin user seed');
    return;
  }

  const normalizedDigits = phone.replace(/\D/g, '');
  const normalized =
    normalizedDigits.length === 12 && normalizedDigits.startsWith('998')
      ? `+${normalizedDigits}`
      : normalizedDigits.length === 9
        ? `+998${normalizedDigits}`
        : null;

  if (!normalized) {
    throw new Error(`[seed] ADMIN_PHONE "${phone}" is not a valid Uzbek phone number`);
  }

  const existing = await knex('users').where({ phone: normalized }).first();
  if (existing) {
    // eslint-disable-next-line no-console
    console.log('[seed] Admin user already exists — skipping');
    return;
  }

  const role = await knex('roles').where({ code: 'ADMIN' }).first();
  if (!role) {
    throw new Error('[seed] ADMIN role not found — run the roles seed first');
  }

  const rounds = Number(process.env.BCRYPT_ROUNDS ?? 12);
  await knex('users').insert({
    first_name: process.env.ADMIN_FIRST_NAME ?? 'Admin',
    last_name: process.env.ADMIN_LAST_NAME ?? 'EASY GAS',
    phone: normalized,
    password_hash: await bcrypt.hash(password, rounds),
    region: 'Toshkent shahri',
    branch_id: null,
    role_id: role.id,
    status: 'ACTIVE',
  });

  // eslint-disable-next-line no-console
  console.log(`[seed] Admin user created for ${normalized}`);
}
