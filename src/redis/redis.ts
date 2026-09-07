import { Redis } from 'ioredis';
import { env, isProduction, isTest } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Phase 10C Redis abstraction.
 *
 * The app depends only on this small interface, never on ioredis directly, so
 * production uses a real shared Redis while dev/test uses an isolated in-memory
 * implementation with identical atomic semantics (no Redis server needed in
 * CI). Redis credentials are never logged.
 */
export interface RedisLike {
  readonly kind: 'redis' | 'memory';
  /** Liveness probe. Resolves 'PONG' (or throws/rejects on failure/timeout). */
  ping(): Promise<string>;
  /**
   * Atomic fixed-window counter: increments `key`, sets its TTL to `windowMs`
   * on the first increment of a window, and returns the new count plus the
   * remaining TTL. This is the primitive the rate limiter is built on.
   */
  incrWindow(key: string, windowMs: number): Promise<{ count: number; ttlMs: number }>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Closes the connection (no-op for the memory impl beyond clearing state). */
  quit(): Promise<void>;
}

// Atomic fixed-window counter (single EVAL — INCR, TTL check, conditional
// PEXPIRE, all server-side): increments the key, and sets the window TTL when
// the key has none (PTTL < 0 covers both the first hit AND repairing any stray
// key that ended up without a TTL — so a counter can never block forever). A
// later hit within the window keeps the ORIGINAL expiry. Returns {count, ttlMs}.
const INCR_WINDOW_LUA = `
local c = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {c, ttl}
`;

class RedisBackend implements RedisLike {
  readonly kind = 'redis' as const;
  constructor(private readonly client: Redis) {}

  async ping(): Promise<string> {
    return this.client.ping();
  }

  async incrWindow(key: string, windowMs: number): Promise<{ count: number; ttlMs: number }> {
    const res = (await this.client.eval(INCR_WINDOW_LUA, 1, key, String(windowMs))) as [number, number];
    const count = Number(res[0]);
    let ttlMs = Number(res[1]);
    if (ttlMs < 0) ttlMs = windowMs; // -1/-2 (no expiry / missing) → treat as full window
    return { count, ttlMs };
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    if (ttlMs && ttlMs > 0) await this.client.set(key, value, 'PX', ttlMs);
    else await this.client.set(key, value);
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async quit(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}

/**
 * In-memory RedisLike for dev/test. Uses an injectable clock so window/expiry
 * behavior can be tested deterministically without real time. Sharing one
 * instance between two app instances models a shared Redis.
 */
export class MemoryRedis implements RedisLike {
  readonly kind = 'memory' as const;
  private readonly store = new Map<string, { value: string; expiresAt: number | null }>();
  constructor(private readonly clock: () => number = Date.now) {}

  private live(key: string): { value: string; expiresAt: number | null } | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expiresAt !== null && e.expiresAt <= this.clock()) {
      this.store.delete(key);
      return undefined;
    }
    return e;
  }

  async ping(): Promise<string> {
    return 'PONG';
  }

  async incrWindow(key: string, windowMs: number): Promise<{ count: number; ttlMs: number }> {
    const now = this.clock();
    const existing = this.live(key);
    if (!existing) {
      this.store.set(key, { value: '1', expiresAt: now + windowMs });
      return { count: 1, ttlMs: windowMs };
    }
    const count = Number(existing.value) + 1;
    existing.value = String(count);
    // Mirror the Lua: a key with no TTL is repaired to the window (never blocks
    // forever); a key within its window keeps its original expiry.
    if (existing.expiresAt === null) existing.expiresAt = now + windowMs;
    const ttlMs = Math.max(0, existing.expiresAt - now);
    return { count, ttlMs };
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    this.store.set(key, { value, expiresAt: ttlMs && ttlMs > 0 ? this.clock() + ttlMs : null });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async quit(): Promise<void> {
    this.store.clear();
  }
}

let instance: RedisLike | null = null;

/** Test-only injection (memory impl / fake clock). Never available in production. */
export function setRedisForTesting(r: RedisLike | null): void {
  if (isProduction) throw new Error('setRedisForTesting is not available in production');
  instance = r;
}

/** Builds the real ioredis client with bounded backoff and strict timeouts. */
function buildRedisBackend(url: string): RedisBackend {
  const client = new Redis(url, {
    connectTimeout: env.REDIS_CONNECT_TIMEOUT_MS,
    commandTimeout: env.REDIS_COMMAND_TIMEOUT_MS,
    keyPrefix: env.REDIS_KEY_PREFIX,
    lazyConnect: true,
    // Fail fast rather than queueing commands while disconnected — the rate
    // limiter's fail-open/closed policy decides what to do, not a hidden queue.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 2,
    // Bounded reconnect backoff (never an unbounded/no backoff hot loop).
    retryStrategy: (times) => Math.min(times * 200, 3_000),
    // TLS is inferred from a rediss:// URL by ioredis; no credentials logged.
  });
  client.on('error', (err) => logger.warn({ err: err?.message }, 'Redis connection error'));
  return new RedisBackend(client);
}

/**
 * Returns the process-wide RedisLike. Production requires REDIS_URL (fail-closed
 * abuse controls depend on it). Development uses a real Redis when REDIS_URL is
 * set, else the in-memory impl.
 *
 * Under NODE_ENV=test the in-memory impl is used UNCONDITIONALLY — even when a
 * REDIS_URL is present (e.g. a CI Redis service container). This is the module's
 * documented design ("no Redis server needed in CI") and it is what makes the
 * e2e suites correct: the in-memory impl is always ready (no lazy-connect race
 * that would make the first rate-limited request fail closed with a spurious 429)
 * and holds no socket/reconnect timer (so a suite never leaves an open handle
 * that keeps the process alive after it finishes). A suite that needs a specific
 * impl still injects it explicitly via setRedisForTesting().
 */
export function getRedis(): RedisLike {
  if (instance) return instance;
  if (isTest) {
    instance = new MemoryRedis();
  } else if (env.REDIS_URL) {
    instance = buildRedisBackend(env.REDIS_URL);
  } else if (isProduction) {
    throw new Error('REDIS_URL is required in production');
  } else {
    logger.info('No REDIS_URL set — using in-memory Redis (development/test only)');
    instance = new MemoryRedis();
  }
  return instance;
}

/** Connects + pings with an overall timeout so startup never hangs forever. */
export async function connectRedis(timeoutMs = env.REDIS_CONNECT_TIMEOUT_MS): Promise<RedisLike> {
  const r = getRedis();
  const pong = r.ping();
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Redis connect/ping timed out')), timeoutMs).unref?.(),
  );
  await Promise.race([pong, timeout]);
  return r;
}

export async function closeRedis(): Promise<void> {
  if (instance) {
    await instance.quit().catch(() => undefined);
    instance = null;
  }
}
