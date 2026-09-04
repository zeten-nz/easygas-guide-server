import path from 'node:path';
import dotenv from 'dotenv';
import type { Knex } from 'knex';

dotenv.config({ path: path.resolve(__dirname, '.env'), quiet: true });

const config: Knex.Config = {
  client: 'mysql2',
  connection: {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME,
    charset: 'utf8mb4',
  },
  pool: { min: 0, max: 5 },
  migrations: {
    directory: './migrations',
    extension: 'ts',
  },
  seeds: {
    directory: './seeds',
    extension: 'ts',
  },
};

export default config;
