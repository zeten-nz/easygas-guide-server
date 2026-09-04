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

  /**
   * Number of reverse proxies (e.g. Nginx) in front of the API. 0 (default,
   * safe for development) means X-Forwarded-For is NEVER trusted and req.ip is
   * the socket address. Set to 1 when exactly one Nginx sits in front, so
   * audit logs and rate limiting key on the real client IP. Never set higher
   * than the actual number of trusted proxies — extra hops let clients spoof
   * their IP via X-Forwarded-For.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),

  /**
   * Database used by the E2E suites. Destructive test cleanup refuses to run
   * unless NODE_ENV=test and the database name ends with "_test"
   * (tests/helpers/test-env.ts enforces this fail-closed).
   */
  TEST_DB_NAME: z.string().regex(/_test$/, 'TEST_DB_NAME must end with "_test"').optional(),
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
