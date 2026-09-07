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
  // --- Phase 10C session lifecycle (replaces the single long-lived TTL) ---
  // Absolute lifetime cap for a "remember me" session family; a session can
  // never live past created_at + this, regardless of activity or rotation.
  SESSION_ABSOLUTE_DAYS: z.coerce.number().int().positive().default(30),
  // Idle timeout: a session dies this long after its last use (applies to both
  // remember and non-remember sessions).
  SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(720), // 12h
  // Rotate the opaque token at most once per this interval (not every request).
  SESSION_ROTATE_MINUTES: z.coerce.number().int().positive().default(60),
  // How long a just-rotated (superseded) token stays usable, to absorb the
  // browser's in-flight parallel requests without minting divergent sessions.
  SESSION_ROTATION_GRACE_SECONDS: z.coerce.number().int().nonnegative().default(30),
  // Retained for the non-remember cookie maxAge only (kept for compatibility).
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(24),
  SESSION_REMEMBER_TTL_DAYS: z.coerce.number().int().positive().default(180),

  // SMS is DISABLED unless a real provider is explicitly selected. EasyGas is
  // employee-only and no enabled feature uses SMS after manual recovery replaced
  // OTP, so production requires NO SMS provider by default (see smsFeatureEnabled
  // + validateProductionConfig). 'console' is dev-only.
  SMS_PROVIDER: z.enum(['console', 'eskiz']).optional(),
  OTP_TTL_MINUTES: z.coerce.number().int().positive().default(5),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  RESET_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(10),

  // --- Manual admin password recovery ---
  // How long an admin-issued temporary password is accepted at login before the
  // employee must ask for a new reset (checked on the authoritative login path).
  TEMP_PASSWORD_TTL_MINUTES: z.coerce.number().int().positive().default(1_440), // 24h

  // --- Phase 10C Redis (shared rate limiting + coordination) ---
  // Required in production (fail-closed abuse controls depend on it). Optional
  // in dev/test, where an isolated in-memory implementation is used instead.
  REDIS_URL: z.string().optional(), // redis:// or rediss:// (TLS)
  REDIS_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  REDIS_KEY_PREFIX: z.string().default('eg:'),

  // --- Phase 10C durable SMS outbox / worker ---
  // Optional dedicated 32-byte key (hex or base64) for the outbox body cipher.
  // When unset, an HKDF subkey is derived from APP_KEY (deterministic, survives
  // restart). NEVER an ephemeral random key. See utils/crypto resolveSmsOutboxKey.
  SMS_OUTBOX_ENCRYPTION_KEY: z.string().optional(),
  SMS_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  SMS_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  // A queued message older than this when a worker picks it up is CANCELLED,
  // never delivered (an OTP must not arrive after it has expired).
  SMS_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(300),
  SMS_WORKER_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false' && v !== '0'), // default on; tests drive the worker manually
  SMS_WORKER_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  SMS_WORKER_BATCH: z.coerce.number().int().positive().default(20),
  SMS_LEASE_SECONDS: z.coerce.number().int().positive().default(60),

  // --- Phase 10C Eskiz provider (validated only when SMS_PROVIDER=eskiz) ---
  // NOTE: the Eskiz adapter itself is deferred pending a verified official spec
  // (see docs/PRODUCTION-RUNTIME-10C.md); these are declared so config is ready.
  ESKIZ_EMAIL: z.string().optional(),
  ESKIZ_PASSWORD: z.string().optional(),
  ESKIZ_FROM: z.string().optional(),
  ESKIZ_BASE_URL: z.string().default('https://notify.eskiz.uz/api'),

  // --- Phase 10C maintenance retention (days) ---
  SESSION_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  OTP_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
  SMS_OUTBOX_RETENTION_DAYS: z.coerce.number().int().positive().default(30),

  // --- Phase 10D GPS (loyiha.md §20) — client-reported location evidence policy ---
  GPS_MAX_ACCURACY_METERS: z.coerce.number().positive().default(100),
  GPS_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(300),
  GPS_FUTURE_SKEW_SECONDS: z.coerce.number().int().nonnegative().default(120),

  SUPPORT_TELEGRAM_URL: z.string().default('https://t.me/EasygasGarantbot'),

  // Object storage (§19/§40). 'local' for development/tests; 's3' for
  // production (AWS S3 or any S3-compatible service such as MinIO).
  STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./uploads'),
  // Explicit, documented emergency override to run local storage in production.
  ALLOW_LOCAL_STORAGE_IN_PRODUCTION: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  // S3 configuration (required when STORAGE_PROVIDER=s3; validated at boot).
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ENDPOINT: z.string().optional(), // optional for AWS, required for MinIO
  S3_FORCE_PATH_STYLE: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_SERVER_SIDE_ENCRYPTION: z.string().optional(),

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

  /**
   * Phase 10F operational metrics (Prometheus text exposition at
   * GET /api/v1/metrics). METRICS_ENABLED toggles the endpoint. METRICS_TOKEN,
   * when set, is required as `Authorization: Bearer <token>` to scrape. In
   * production the endpoint is NEVER open: it is refused unless a token is set
   * and matched (and the deploy layer must keep it off the public vhost).
   */
  METRICS_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1') // OFF by default — opt-in, never public by accident
    .pipe(z.boolean()),
  METRICS_TOKEN: z.string().min(16, 'METRICS_TOKEN must be at least 16 characters').optional(),
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
export const isTest = env.NODE_ENV === 'test';

/**
 * Whether any enabled feature actually uses SMS. After manual admin recovery
 * replaced OTP, nothing does — so SMS is enabled ONLY when a real provider is
 * explicitly selected (a future opt-in). Startup, readiness and the release gate
 * only demand a working SMS provider when this is true; otherwise SMS is retired
 * (never faked as healthy). ('console' is dev-only and never counts as enabled.)
 */
export function smsFeatureEnabled(e: typeof env = env): boolean {
  return e.SMS_PROVIDER === 'eskiz';
}

/**
 * Phase 10C production configuration validation. Structural parsing (above)
 * cannot express cross-field production rules, so they are checked here and the
 * process refuses to start in production if any fails. Returns the list of
 * problems (empty when OK) — exported so a test can assert the rules without
 * killing the process.
 */
export function validateProductionConfig(e: typeof env): string[] {
  const problems: string[] = [];
  if (e.NODE_ENV !== 'production') {
    // Guard the inverse in non-prod: never point a test run at a real database.
    if (e.NODE_ENV === 'test' && !/_test$/.test(e.DB_NAME)) {
      problems.push(`In test mode DB_NAME ("${e.DB_NAME}") must end with "_test".`);
    }
    return problems;
  }

  // APP_KEY strength: length is enforced by the schema (>=32); reject an obvious
  // placeholder / low-entropy value in production.
  if (/^(?:x+|0+|secret|changeme|test|dev)/i.test(e.APP_KEY) || new Set(e.APP_KEY.split('')).size < 12) {
    problems.push('APP_KEY looks weak/placeholder — use a long random value (>=32 chars, high entropy).');
  }
  // Exactly-one-Nginx assumption: real client IPs require a trusted proxy hop.
  if (e.TRUST_PROXY_HOPS < 1) {
    problems.push('TRUST_PROXY_HOPS must be >=1 in production (all traffic via one trusted Nginx; Node port not public).');
  }
  // Redis is mandatory: fail-closed auth/OTP/reset abuse controls depend on it.
  if (!e.REDIS_URL) {
    problems.push('REDIS_URL is required in production (shared rate limiting / abuse controls depend on Redis).');
  }
  // Object storage (Phase 10B): production must not silently use local disk.
  if (e.STORAGE_PROVIDER === 'local' && !e.ALLOW_LOCAL_STORAGE_IN_PRODUCTION) {
    problems.push('STORAGE_PROVIDER=local is refused in production (set s3, or ALLOW_LOCAL_STORAGE_IN_PRODUCTION=true to override).');
  }
  if (e.STORAGE_PROVIDER === 's3' && (!e.S3_BUCKET || !e.S3_REGION)) {
    problems.push('STORAGE_PROVIDER=s3 requires S3_BUCKET and S3_REGION.');
  }
  // SMS is DISABLED by default. EasyGas is employee-only and manual admin
  // recovery replaced OTP, so NO enabled feature uses SMS — production requires no
  // SMS provider or Eskiz credentials. console stays dev-only; a real provider is
  // only required to have its credentials WHEN it is explicitly selected.
  if (e.SMS_PROVIDER === 'console') {
    problems.push('SMS_PROVIDER=console is a dev-only provider; leave it unset (SMS disabled) in production.');
  }
  if (e.SMS_PROVIDER === 'eskiz' && (!e.ESKIZ_EMAIL || !e.ESKIZ_PASSWORD || !e.ESKIZ_FROM)) {
    problems.push('SMS_PROVIDER=eskiz requires ESKIZ_EMAIL, ESKIZ_PASSWORD and ESKIZ_FROM (approved sender).');
  }
  // A dedicated outbox key, when set, must decode to exactly 32 bytes (else the
  // cipher would fail at first send). No dedicated key ⇒ HKDF from APP_KEY.
  if (e.SMS_OUTBOX_ENCRYPTION_KEY) {
    const k = e.SMS_OUTBOX_ENCRYPTION_KEY;
    const buf = /^[0-9a-fA-F]{64}$/.test(k) ? Buffer.from(k, 'hex') : Buffer.from(k, 'base64');
    if (buf.length !== 32) problems.push('SMS_OUTBOX_ENCRYPTION_KEY must decode to exactly 32 bytes (hex or base64).');
  }
  if (!e.CLIENT_ORIGIN || /localhost|127\.0\.0\.1/.test(e.CLIENT_ORIGIN)) {
    problems.push('CLIENT_ORIGIN must be the real public origin in production (not localhost).');
  }
  // Cookies are only Secure when NODE_ENV=production (see auth.controller) — that
  // holds here; nothing to add, but assert the DB is not a test schema.
  if (/_test$/.test(e.DB_NAME)) {
    problems.push('DB_NAME must not be a *_test database in production.');
  }
  // Session timing sanity: rotate < idle < absolute; grace bounded.
  const idleMin = e.SESSION_IDLE_MINUTES;
  const absMin = e.SESSION_ABSOLUTE_DAYS * 24 * 60;
  if (!(e.SESSION_ROTATE_MINUTES < idleMin)) problems.push('SESSION_ROTATE_MINUTES must be < SESSION_IDLE_MINUTES.');
  if (!(idleMin <= absMin)) problems.push('SESSION_IDLE_MINUTES must be <= SESSION_ABSOLUTE_DAYS.');
  if (e.SESSION_ROTATION_GRACE_SECONDS > 300) problems.push('SESSION_ROTATION_GRACE_SECONDS should be small (<=300).');
  // Metrics must never be reachable without a strong token in production.
  if (e.METRICS_ENABLED && !e.METRICS_TOKEN) {
    problems.push('METRICS_TOKEN must be set when METRICS_ENABLED in production (or set METRICS_ENABLED=false).');
  }
  return problems;
}

/** Enforces production config at startup (called from server.ts before listen). */
export function assertProductionConfig(): void {
  const problems = validateProductionConfig(env);
  if (problems.length > 0) {
    // eslint-disable-next-line no-console
    console.error('Refusing to start — production configuration problems:');
    for (const p of problems) console.error(`  - ${p}`);
    throw new Error('Invalid production configuration');
  }
}
