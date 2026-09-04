import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { ApiError } from '../utils/errors';
import { hmacSecret, timingSafeEqualHex } from '../utils/crypto';

/**
 * CSRF protection for the cookie-authenticated API (Phase 10A).
 *
 * Model — two independent layers on every state-changing request
 * (POST/PUT/PATCH/DELETE); safe methods (GET/HEAD/OPTIONS) are exempt:
 *
 * 1. Origin screening (ALL mutations, including the public auth endpoints,
 *    so login-CSRF is covered too): when the browser supplies an Origin
 *    header it must match an allowed origin; otherwise, when a Referer is
 *    present it must match. Requests with neither header (curl, server-side
 *    clients, the E2E suites) pass this layer — browsers always attach
 *    Origin to cross-site fetch/form POSTs, which is the attack vector.
 *
 * 2. Session-bound token (every mutation that carries a session cookie):
 *    the client must send `x-csrf-token: HMAC-SHA256(APP_KEY, "csrf:" + raw
 *    session cookie value)`. The token is handed out only by the login and
 *    /auth/me responses (same-origin JSON — unreadable cross-site), lives in
 *    client memory (never localStorage), and rotates with the session.
 *    A cross-site attacker can make the browser send the cookie but can
 *    neither read nor derive the matching header. Requests WITHOUT a session
 *    cookie need no token — there is no session to forge.
 *
 * There is deliberately no per-route exemption list: cookie present ⇒ token
 * required, so no authenticated mutation can bypass the check.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Server-derived CSRF token for a raw session-cookie value. */
export function csrfTokenFor(rawSessionCookie: string): string {
  return hmacSecret(`csrf:${rawSessionCookie}`);
}

function normalizeOrigin(value: string): string | null {
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

const allowedOrigins = new Set([normalizeOrigin(env.CLIENT_ORIGIN)].filter(Boolean) as string[]);

export function csrfProtection(req: Request, _res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  // Layer 1 — browser origin screening.
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== 'null') {
    const normalized = normalizeOrigin(origin);
    if (!normalized || !allowedOrigins.has(normalized)) {
      throw new ApiError(403, 'CSRF_ORIGIN', "So'rov manbai ruxsat etilmagan");
    }
  } else {
    const referer = req.headers.referer;
    if (typeof referer === 'string') {
      const normalized = normalizeOrigin(referer);
      if (!normalized || !allowedOrigins.has(normalized)) {
        throw new ApiError(403, 'CSRF_ORIGIN', "So'rov manbai ruxsat etilmagan");
      }
    }
  }

  // Layer 2 — session-bound token for cookie-bearing requests.
  const rawCookie: unknown = req.cookies?.[env.SESSION_COOKIE_NAME];
  if (typeof rawCookie === 'string' && rawCookie.length > 0) {
    const header = req.headers['x-csrf-token'];
    const expected = csrfTokenFor(rawCookie);
    if (typeof header !== 'string' || !/^[0-9a-f]{64}$/.test(header) || !timingSafeEqualHex(header, expected)) {
      throw new ApiError(403, 'CSRF_TOKEN', 'CSRF tekshiruvi muvaffaqiyatsiz — sahifani yangilab qayta urinib ko\'ring');
    }
  }

  next();
}
