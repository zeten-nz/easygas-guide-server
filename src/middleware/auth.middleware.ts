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

/**
 * §D first-login restriction. A temporary-password session (must_change_password)
 * may reach ONLY the minimum endpoints: change the password, inspect the
 * restricted session (/auth/me), and log out (logout carries no requireAuth, so
 * it is always reachable). Matched on the router mount + route path so it is
 * independent of the API version prefix.
 */
function isTempPasswordAllowlisted(req: Request): boolean {
  return req.baseUrl.endsWith('/auth') && (req.path === '/change-password' || req.path === '/me');
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const resolved = await resolveAuth(req, res);
  if (!resolved) {
    throw ApiError.unauthorized();
  }
  req.user = resolved.user;
  req.authSession = resolved.session;

  // §D — enforce the first-login password change SERVER-SIDE (a React redirect is
  // not a control). Every business API is rejected until the password is changed.
  if (resolved.user.mustChangePassword && !isTempPasswordAllowlisted(req)) {
    throw new ApiError(
      403,
      'PASSWORD_CHANGE_REQUIRED',
      "Vaqtinchalik parolni almashtiring: davom etish uchun yangi parol o'rnating",
    );
  }

  next();
}

/**
 * Attaches req.user when a valid session cookie is present, but never rejects.
 * Still applies rotation/CSRF delivery for authenticated callers.
 */
export async function optionalAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const resolved = await resolveAuth(req, res);
  // §D — a temporary-password session is confined: on optional-auth routes it is
  // treated as anonymous, so it never receives elevated (management) data. It can
  // still only escape by changing the password on the allowlisted routes.
  if (resolved && !resolved.user.mustChangePassword) {
    req.user = resolved.user;
    req.authSession = resolved.session;
  }
  next();
}
