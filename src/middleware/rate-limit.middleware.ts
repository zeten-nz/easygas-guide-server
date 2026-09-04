import type { Request } from 'express';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { normalizePhone } from '../utils/phone';

const message = {
  error: { code: 'TOO_MANY_REQUESTS', message: "Urinishlar soni oshib ketdi. Birozdan so'ng qayta urinib ko'ring." },
};

const common = {
  standardHeaders: true as const,
  legacyHeaders: false,
  message,
  // Proxy trust is configured explicitly at the app level (TRUST_PROXY_HOPS,
  // see src/app.ts). With hops=0 Express ignores X-Forwarded-For entirely, so
  // the library's own header/proxy heuristics would only produce noise.
  validate: { xForwardedForHeader: false, trustProxy: false },
};

/**
 * NOTE: stores are in-memory (no Redis on this deployment yet). Limits reset
 * on process restart — acceptable for development; production will move these
 * to a shared store.
 */

function phoneOrIpKey(req: Request): string {
  const phone = typeof req.body?.phone === 'string' ? normalizePhone(req.body.phone) : null;
  return phone ?? ipKeyGenerator(req.ip ?? '');
}

/** Broad safety net for the whole API. */
export const apiLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  limit: 600,
});

/** Login brute-force protection per IP. */
export const loginIpLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  limit: 30,
});

/** Login brute-force protection per target phone (across IPs). */
export const loginPhoneLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  limit: 10,
  keyGenerator: phoneOrIpKey,
});

export const registerLimiter = rateLimit({
  ...common,
  windowMs: 60 * 60 * 1000,
  limit: 10,
});

/** OTP request limits: strict per phone, looser per IP. */
export const otpRequestPhoneLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  limit: 3,
  keyGenerator: phoneOrIpKey,
});

export const otpRequestIpLimiter = rateLimit({
  ...common,
  windowMs: 60 * 60 * 1000,
  limit: 15,
});

/** OTP verification attempts (DB attempt counter also applies per code). */
export const otpVerifyLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  limit: 15,
  keyGenerator: phoneOrIpKey,
});

export const resetPasswordLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  limit: 10,
});
