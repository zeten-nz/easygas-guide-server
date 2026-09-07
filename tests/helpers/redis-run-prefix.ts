/**
 * Unique per-run Redis key prefix for the real-Redis integration suite.
 *
 * MUST be imported BEFORE src/config/env (and therefore before src/redis and the
 * app) so `env.REDIS_KEY_PREFIX` — which ioredis applies to every key — is this
 * run's unique value. That way the app under test AND every Redis client the suite
 * opens write their keys under a single throwaway namespace, and cleanup can delete
 * exactly and only `RUN_PREFIX*`, never the shared `eg:*`/`eg:rl:*` namespace.
 *
 * Importing this only sets a process env var (no config/Redis is initialized here).
 */
import { randomUUID } from 'node:crypto';

export const RUN_PREFIX = `itest:${randomUUID()}:`;

// Pin the app's Redis key prefix to this run's unique value, unconditionally, so
// env.REDIS_KEY_PREFIX (read once at env load) === RUN_PREFIX and every key the app
// or the suite writes lives under exactly this throwaway namespace.
process.env.REDIS_KEY_PREFIX = RUN_PREFIX;
