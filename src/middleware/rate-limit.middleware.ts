import type { NextFunction, Request, Response } from 'express';
import { getRedis } from '../redis/redis';
import { isProduction } from '../config/env';
import { hmacSecret } from '../utils/crypto';
import { normalizePhone } from '../utils/phone';
import { logger } from '../utils/logger';

/**
 * Test-only escape hatch for the reproducible browser E2E harness
 * (server: `npm run test:e2e:serve`), which logs the SAME demo user in across
 * many Playwright tests and re-runs and would otherwise trip the abuse limiters.
 * STRICTLY guarded: it can NEVER be active in production, and it is read
 * per-request so it only applies while the harness sets it. The real limiters are
 * still exercised by tests/ratelimit.e2e (which never sets this flag).
 */
function rateLimitBypassedForE2E(): boolean {
  return !isProduction && process.env.E2E_DISABLE_RATE_LIMIT === '1';
}

/**
 * Phase 10C shared rate limiting.
 *
 * Backed by the RedisLike abstraction (real Redis in production, in-memory in
 * dev/test) so counters are shared across every PM2 instance and survive
 * restarts. Atomic INCR + first-hit TTL per window. Keys are namespaced and
 * never contain PII: phone-based limits key on an HMAC of the normalized phone,
 * never the raw number.
 *
 * Failure policy:
 *  - failMode 'closed' (login/OTP/reset/registration abuse controls): if Redis
 *    is unreachable the request is BLOCKED (a 429) — abuse protection is never
 *    silently disabled.
 *  - failMode 'open' (ordinary authenticated/API traffic): if Redis is
 *    unreachable the request is ALLOWED but the failure is logged.
 */

const MESSAGE = {
  error: { code: 'TOO_MANY_REQUESTS', message: "Urinishlar soni oshib ketdi. Birozdan so'ng qayta urinib ko'ring." },
};

export interface LimiterOptions {
  name: string;
  windowMs: number;
  limit: number;
  failMode: 'open' | 'closed';
  /** Derives the identity dimension; returns null to skip this limiter for the request. */
  key: (req: Request) => string | null;
}

/** Trusted client IP (Phase 10A: req.ip already honors TRUST_PROXY_HOPS). */
export function ipKey(req: Request): string {
  return `ip:${req.ip ?? 'unknown'}`;
}

/** Irreversible, namespaced key for a phone number — the raw number never hits Redis. */
export function phoneKey(phone: string): string {
  return `ph:${hmacSecret(`rlphone:${normalizePhone(phone)}`).slice(0, 32)}`;
}

/** login/OTP/reset key on the target phone when present, else the IP. */
function phoneOrIp(req: Request): string {
  const phone = typeof req.body?.phone === 'string' ? req.body.phone : null;
  return phone ? phoneKey(phone) : ipKey(req);
}

function reject(res: Response, ttlMs: number, limit: number): void {
  const retryAfter = Math.max(1, Math.ceil(ttlMs / 1000));
  res.setHeader('Retry-After', String(retryAfter));
  res.setHeader('RateLimit-Limit', String(limit));
  res.setHeader('RateLimit-Remaining', '0');
  res.setHeader('RateLimit-Reset', String(retryAfter));
  res.status(429).json(MESSAGE);
}

export function createRateLimiter(opts: LimiterOptions) {
  return async function rateLimiter(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (rateLimitBypassedForE2E()) {
      next();
      return;
    }
    const dim = opts.key(req);
    if (dim === null) {
      next();
      return;
    }
    const redisKey = `rl:${opts.name}:${dim}`;
    let result: { count: number; ttlMs: number };
    try {
      result = await getRedis().incrWindow(redisKey, opts.windowMs);
    } catch (err) {
      // Redis unavailable — apply the configured failure policy. Never throw
      // into the request pipeline (that would 500 every request).
      if (opts.failMode === 'closed') {
        logger.error({ limiter: opts.name, err: (err as Error)?.message }, 'Rate limiter Redis error — failing CLOSED');
        reject(res, opts.windowMs, opts.limit);
        return;
      }
      logger.warn({ limiter: opts.name, err: (err as Error)?.message }, 'Rate limiter Redis error — failing OPEN');
      next();
      return;
    }
    if (result.count > opts.limit) {
      reject(res, result.ttlMs, opts.limit);
      return;
    }
    res.setHeader('RateLimit-Limit', String(opts.limit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, opts.limit - result.count)));
    next();
  };
}

const M = 60 * 1000;

/** Broad safety net for the whole API — fail OPEN (availability over strictness). */
export const apiLimiter = createRateLimiter({ name: 'api', windowMs: 15 * M, limit: 600, failMode: 'open', key: ipKey });

/** Login brute-force protection per IP — fail CLOSED. */
export const loginIpLimiter = createRateLimiter({ name: 'login-ip', windowMs: 15 * M, limit: 30, failMode: 'closed', key: ipKey });

/** Login brute-force protection per target phone (across IPs) — fail CLOSED. */
export const loginPhoneLimiter = createRateLimiter({ name: 'login-ph', windowMs: 15 * M, limit: 10, failMode: 'closed', key: phoneOrIp });

export const registerLimiter = createRateLimiter({ name: 'register', windowMs: 60 * M, limit: 10, failMode: 'closed', key: ipKey });

/** OTP request: strict per phone, looser per IP — fail CLOSED (SMS costs money + abuse). */
export const otpRequestPhoneLimiter = createRateLimiter({ name: 'otp-req-ph', windowMs: 15 * M, limit: 3, failMode: 'closed', key: phoneOrIp });
export const otpRequestIpLimiter = createRateLimiter({ name: 'otp-req-ip', windowMs: 60 * M, limit: 15, failMode: 'closed', key: ipKey });

/** OTP verification attempts (DB attempt counter also applies per code) — fail CLOSED. */
export const otpVerifyLimiter = createRateLimiter({ name: 'otp-verify', windowMs: 15 * M, limit: 15, failMode: 'closed', key: phoneOrIp });

export const resetPasswordLimiter = createRateLimiter({ name: 'reset-pw', windowMs: 15 * M, limit: 10, failMode: 'closed', key: ipKey });

/** Authenticated upload throttle, keyed by user — fail OPEN. */
export const uploadLimiter = createRateLimiter({
  name: 'upload',
  windowMs: 5 * M,
  limit: 120,
  failMode: 'open',
  key: (req) => (req.user ? `u:${req.user.id}` : ipKey(req)),
});
