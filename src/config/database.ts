import knex, { Knex } from 'knex';
import { env } from './env';

export const db: Knex = knex({
  client: 'mysql2',
  connection: {
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    charset: 'utf8mb4',
  },
  pool: { min: 0, max: 10 },
});
