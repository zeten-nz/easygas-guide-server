import type { NextFunction, Request, Response } from 'express';
import { db } from '../config/database';
import { env } from '../config/env';
import { ApiError } from '../utils/errors';
import { csrfTokenFor } from './csrf.middleware';
import { resolveSession, setSessionCookie } from '../modules/auth/session.service';
import { toAuthUser, type UserWithRole } from '../modules/users/user.mapper';
import type { AuthUser, SessionRow } from '../types/auth';

interface ResolvedAuth {
  user: AuthUser;
  session: SessionRow;
}

/**
 * Resolves the session cookie to an active session + active user, applying the
 * Phase 10C lifecycle (absolute/idle expiry + token rotation + replay defense).
 * When the token rotates, the new cookie and a fresh CSRF token are delivered on
 * the response; on every authenticated response the current CSRF token and its
 * monotonic rotation sequence are exposed so the SPA can converge safely.
 * Returns null (unauthenticated) for any invalid/expired/revoked/replayed token.
 */
async function resolveAuth(req: Request, res: Response): Promise<ResolvedAuth | null> {
  const rawToken: unknown = req.cookies?.[env.SESSION_COOKIE_NAME];
  const outcome = await resolveSession(rawToken);
  if (outcome === 'invalid' || outcome === 'replay') return null;

  const user = (await db('users')
    .select('users.*', 'roles.code as role_code', 'branches.status as branch_status')
    .join('roles', 'roles.id', 'users.role_id')
    .leftJoin('branches', 'branches.id', 'users.branch_id')
    .where('users.id', outcome.session.user_id)
    .whereNull('users.deleted_at')
    .first()) as (UserWithRole & { branch_status: string | null }) | undefined;

  if (!user || user.status !== 'ACTIVE') return null;
  // Phase 10A branch policy: users on a deactivated branch cannot authenticate.
  if (user.branch_id !== null && user.branch_status !== 'ACTIVE') return null;

  // Deliver the effective CSRF token + rotation sequence. On rotation the new
  // cookie is set here; the CSRF token is HMAC(cookie) so it follows the token.
  const effectiveToken = outcome.rotated?.token ?? (rawToken as string);
  if (outcome.rotated) {
    setSessionCookie(res, outcome.rotated.token, outcome.rotated.rememberMe, outcome.rotated.absoluteExpiresAt);
  }
  res.setHeader('x-csrf-token', csrfTokenFor(effectiveToken));
  res.setHeader('x-session-rotation', String(outcome.session.rotation_seq));

  return { user: toAuthUser(user), session: outcome.session };
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const resolved = await resolveAuth(req, res);
  if (!resolved) {
    throw ApiError.unauthorized();
  }
  req.user = resolved.user;
  req.authSession = resolved.session;
  next();
}

/**
 * Attaches req.user when a valid session cookie is present, but never rejects.
 * Still applies rotation/CSRF delivery for authenticated callers.
 */
export async function optionalAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const resolved = await resolveAuth(req, res);
  if (resolved) {
    req.user = resolved.user;
    req.authSession = resolved.session;
  }
  next();
}
