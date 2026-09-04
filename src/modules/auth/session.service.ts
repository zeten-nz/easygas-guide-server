import crypto from 'node:crypto';
import type { CookieOptions, Response } from 'express';
import { db } from '../../config/database';
import { env, isProduction } from '../../config/env';
import { generateSessionToken, hashSessionToken } from '../../utils/crypto';
import type { SessionRow } from '../../types/auth';

/**
 * Phase 10C session lifecycle.
 *
 * A login creates a session FAMILY (family_id). The opaque token is rotated at
 * most once per SESSION_ROTATE_MINUTES; each rotation mints a new token/row in
 * the same family and marks the old one superseded. A superseded token stays
 * usable for a short grace window (absorbs the browser's in-flight parallel
 * requests) and is treated as a replay — revoking the whole family — if used
 * after grace. Absolute + idle caps bound total lifetime.
 *
 * Rotation is atomic across parallel requests and PM2 instances: the winner
 * holds a row lock (SELECT ... FOR UPDATE) while it mints the successor, so a
 * concurrent request cannot create a divergent successor — it either serves on
 * the old token during grace, or picks up the new cookie on its next request.
 * No process-local mutex is used.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const IDLE_MS = env.SESSION_IDLE_MINUTES * 60 * 1000;
const ROTATE_MS = env.SESSION_ROTATE_MINUTES * 60 * 1000;
const GRACE_MS = env.SESSION_ROTATION_GRACE_SECONDS * 1000;

export function sessionCookieOptions(rememberMe: boolean, absoluteExpiresAt: Date): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax', // compatible with the Origin/Referer + token CSRF layers (Phase 10A)
    path: '/',
    // Persistent cookie only for "remember me"; otherwise a browser-session
    // cookie (the server-side idle/absolute caps still apply).
    ...(rememberMe ? { expires: absoluteExpiresAt } : {}),
  };
}

/** Sets the session cookie for a raw token (login and rotation share this). */
export function setSessionCookie(res: Response, rawToken: string, rememberMe: boolean, absoluteExpiresAt: Date): void {
  res.cookie(env.SESSION_COOKIE_NAME, rawToken, sessionCookieOptions(rememberMe, absoluteExpiresAt));
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(env.SESSION_COOKIE_NAME, { httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/' });
}

export interface CreatedSession {
  token: string;
  rememberMe: boolean;
  absoluteExpiresAt: Date;
  rotationSeq: number;
}

/** Creates a brand-new session family for a fresh login. */
export async function createSession(
  userId: number,
  rememberMe: boolean,
  meta: { ip: string | null; userAgent: string | null },
): Promise<CreatedSession> {
  const token = generateSessionToken();
  const now = Date.now();
  const absoluteExpiresAt = new Date(now + (rememberMe ? env.SESSION_ABSOLUTE_DAYS * DAY_MS : env.SESSION_TTL_HOURS * HOUR_MS));
  const id = crypto.randomUUID();
  await db('sessions').insert({
    id,
    user_id: userId,
    token_hash: hashSessionToken(token),
    remember_me: rememberMe,
    expires_at: absoluteExpiresAt, // legacy column kept aligned to the absolute cap
    absolute_expires_at: absoluteExpiresAt,
    family_id: id, // the family root is the session itself
    rotation_seq: 0,
    ip: meta.ip,
    user_agent: meta.userAgent,
  });
  return { token, rememberMe, absoluteExpiresAt, rotationSeq: 0 };
}

export interface ResolvedSession {
  session: SessionRow;
  /** Present when this request rotated the token; the caller sets the new cookie. */
  rotated: { token: string; rememberMe: boolean; absoluteExpiresAt: Date } | null;
}

export type ResolveOutcome = ResolvedSession | 'invalid' | 'replay';

/**
 * Resolves a raw cookie token to a live session, rotating it when due. Returns
 * 'invalid' for missing/expired/revoked; 'replay' when a rotated-out token is
 * reused after its grace window (the family is revoked as a side effect).
 */
export async function resolveSession(rawToken: unknown): Promise<ResolveOutcome> {
  if (typeof rawToken !== 'string' || rawToken.length !== 64) return 'invalid';
  const row = (await db('sessions').where({ token_hash: hashSessionToken(rawToken) }).first()) as SessionRow | undefined;
  if (!row || row.revoked_at) return 'invalid';

  const now = Date.now();
  if (new Date(row.absolute_expires_at).getTime() <= now) return 'invalid';
  if (now - new Date(row.last_used_at).getTime() > IDLE_MS) return 'invalid';

  if (row.superseded_at) {
    const sinceSuperseded = now - new Date(row.superseded_at).getTime();
    if (sinceSuperseded <= GRACE_MS) {
      // In-flight parallel request within grace — accept without re-rotating or
      // re-issuing; the request that won the rotation already delivered the new
      // cookie/CSRF, and this response's lower rotation_seq won't overwrite it.
      return { session: row, rotated: null };
    }
    // Reused after grace → replay of a token that should be dead. Revoke the family.
    await revokeFamily(row.family_id);
    return 'replay';
  }

  // Current token — rotate if due.
  if (now - new Date(row.created_at).getTime() > ROTATE_MS) {
    const rotation = await rotateSession(row.id);
    if (rotation) {
      return {
        session: rotation.successor,
        rotated: { token: rotation.token, rememberMe: !!rotation.successor.remember_me, absoluteExpiresAt: new Date(rotation.successor.absolute_expires_at) },
      };
    }
    // Lost the rotation race: the winner just superseded this row (within grace).
    // Serve on it; the browser adopts the new cookie on its next request.
    return { session: row, rotated: null };
  }

  // No rotation — refresh idle marker at most once a minute (avoid a write/req).
  if (now - new Date(row.last_used_at).getTime() > 60_000) {
    await db('sessions').where({ id: row.id }).update({ last_used_at: db.fn.now() });
  }
  return { session: row, rotated: null };
}

/**
 * Atomically rotates the current token to a successor under a row lock. Returns
 * null if a concurrent request already rotated this row (the caller then serves
 * on the old token during grace). PM2-safe: the lock lives in MySQL, not the
 * process.
 */
async function rotateSession(currentId: string): Promise<{ token: string; successor: SessionRow } | null> {
  return db.transaction(async (trx) => {
    const cur = (await trx('sessions').where({ id: currentId }).forUpdate().first()) as SessionRow | undefined;
    if (!cur || cur.superseded_at || cur.revoked_at) return null;
    const token = generateSessionToken();
    const successorId = crypto.randomUUID();
    await trx('sessions').insert({
      id: successorId,
      user_id: cur.user_id,
      token_hash: hashSessionToken(token),
      remember_me: cur.remember_me,
      expires_at: cur.expires_at,
      absolute_expires_at: cur.absolute_expires_at, // rotation never extends the absolute cap
      family_id: cur.family_id,
      rotation_seq: cur.rotation_seq + 1,
      last_used_at: trx.fn.now(),
      ip: cur.ip,
      user_agent: cur.user_agent,
    });
    await trx('sessions').where({ id: currentId }).update({ superseded_at: trx.fn.now(), rotated_to_id: successorId });
    const successor = (await trx('sessions').where({ id: successorId }).first()) as SessionRow;
    return { token, successor };
  });
}

/** Revokes one session by its raw token (logout). */
export async function revokeByToken(rawToken: string | undefined): Promise<SessionRow | null> {
  if (typeof rawToken !== 'string' || rawToken.length !== 64) return null;
  const row = (await db('sessions').where({ token_hash: hashSessionToken(rawToken) }).whereNull('revoked_at').first()) as
    | SessionRow
    | undefined;
  if (!row) return null;
  // Revoke the whole family so a superseded predecessor can't linger post-logout.
  await revokeFamily(row.family_id);
  return row;
}

export async function revokeFamily(familyId: string): Promise<number> {
  return db('sessions').where({ family_id: familyId }).whereNull('revoked_at').update({ revoked_at: db.fn.now() });
}
