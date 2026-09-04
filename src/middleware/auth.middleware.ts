import type { NextFunction, Request, Response } from 'express';
import { db } from '../config/database';
import { env } from '../config/env';
import { ApiError } from '../utils/errors';
import { hashSessionToken } from '../utils/crypto';
import { toAuthUser, type UserWithRole } from '../modules/users/user.mapper';
import type { AuthUser, SessionRow } from '../types/auth';

interface ResolvedAuth {
  user: AuthUser;
  session: SessionRow;
}

/**
 * Resolves the session cookie to an active session + active user, or null.
 * Rejects expired/revoked sessions and inactive users (a blocked user's
 * existing sessions become useless immediately).
 */
async function resolveAuth(req: Request): Promise<ResolvedAuth | null> {
  const token: unknown = req.cookies?.[env.SESSION_COOKIE_NAME];
  if (typeof token !== 'string' || token.length !== 64) return null;

  const session = (await db('sessions')
    .where({ token_hash: hashSessionToken(token) })
    .first()) as SessionRow | undefined;

  if (!session || session.revoked_at || new Date(session.expires_at).getTime() <= Date.now()) {
    return null;
  }

  const user = (await db('users')
    .select('users.*', 'roles.code as role_code')
    .join('roles', 'roles.id', 'users.role_id')
    .where('users.id', session.user_id)
    .whereNull('users.deleted_at')
    .first()) as UserWithRole | undefined;

  if (!user || user.status !== 'ACTIVE') return null;

  // Touch last_used_at at most once a minute to avoid a write per request.
  if (Date.now() - new Date(session.last_used_at).getTime() > 60_000) {
    await db('sessions').where({ id: session.id }).update({ last_used_at: db.fn.now() });
  }

  return { user: toAuthUser(user), session };
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const resolved = await resolveAuth(req);
  if (!resolved) {
    throw ApiError.unauthorized();
  }
  req.user = resolved.user;
  req.authSession = resolved.session;
  next();
}

/**
 * Attaches req.user when a valid session cookie is present, but never rejects.
 * Used by endpoints that adapt their response to the caller (e.g. GET /branches
 * returns full management data to authorized users, a minimal public list otherwise).
 */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const resolved = await resolveAuth(req);
  if (resolved) {
    req.user = resolved.user;
    req.authSession = resolved.session;
  }
  next();
}
