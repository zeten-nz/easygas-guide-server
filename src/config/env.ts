import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  CLIENT_ORIGIN: z.string().default('http://localhost:5173'),

  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z.string().min(1),

  // Server-side secret used to HMAC OTP codes and reset tokens. Must be long and random.
  APP_KEY: z.string().min(32, 'APP_KEY must be at least 32 characters'),

  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),

  SESSION_COOKIE_NAME: z.string().default('eg_session'),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(24),
  SESSION_REMEMBER_TTL_DAYS: z.coerce.number().int().positive().default(180),

  SMS_PROVIDER: z.enum(['console']).optional(),
  OTP_TTL_MINUTES: z.coerce.number().int().positive().default(5),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  RESET_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(10),

  SUPPORT_TELEGRAM_URL: z.string().default('https://t.me/EasygasGarantbot'),

  // Object storage (§19/§40): 'local' for development; S3/MinIO providers later.
  STORAGE_PROVIDER: z.enum(['local']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./uploads'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    // eslint-disable-next-line no-console
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === 'production';
