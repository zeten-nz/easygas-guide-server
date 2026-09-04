import type { Request, Response } from 'express';
import { env } from '../../config/env';
import { csrfTokenFor } from '../../middleware/csrf.middleware';
import { setSessionCookie, clearSessionCookie } from './session.service';
import { requestMeta } from '../audit/audit.service';
import * as authService from './auth.service';

export async function login(req: Request, res: Response): Promise<void> {
  const result = await authService.login(req.body, requestMeta(req));
  setSessionCookie(res, result.token, result.rememberMe, result.expiresAt);
  // Session-bound CSRF token (see csrf.middleware.ts) — client memory only. The
  // rotation sequence lets the SPA ignore an out-of-order older CSRF value.
  res.setHeader('x-csrf-token', csrfTokenFor(result.token));
  res.setHeader('x-session-rotation', String(result.rotationSeq));
  res.json({ user: result.user, csrfToken: csrfTokenFor(result.token), rotationSeq: result.rotationSeq });
}

export async function logout(req: Request, res: Response): Promise<void> {
  await authService.logout(req.cookies?.[env.SESSION_COOKIE_NAME], requestMeta(req));
  clearSessionCookie(res);
  res.status(204).end();
}

export async function me(req: Request, res: Response): Promise<void> {
  // requireAuth has already delivered the effective CSRF token + rotation seq as
  // response headers (and rotated the cookie if due); echo them in the body so a
  // reloaded SPA can bootstrap its in-memory CSRF state.
  const csrfToken = (res.getHeader('x-csrf-token') as string) ?? '';
  const rotationSeq = req.authSession?.rotation_seq ?? 0;
  res.json({ user: req.user, csrfToken, rotationSeq });
}

export async function register(req: Request, res: Response): Promise<void> {
  const { id } = await authService.createRegistrationRequest(req.body, requestMeta(req));
  res.status(201).json({
    request: { id, status: 'PENDING' },
    message: "So'rovingiz qabul qilindi. Administrator tasdiqlaganidan so'ng tizimga kira olasiz.",
  });
}

export async function forgotPassword(req: Request, res: Response): Promise<void> {
  const result = await authService.requestPasswordReset(req.body.phone, requestMeta(req));
  res.json(result);
}

export async function verifyOtp(req: Request, res: Response): Promise<void> {
  const result = await authService.verifyOtp(req.body.phone, req.body.otp);
  res.json(result);
}

export async function resetPassword(req: Request, res: Response): Promise<void> {
  await authService.resetPassword(req.body.resetToken, req.body.password, requestMeta(req));
  res.json({ message: "Parol muvaffaqiyatli o'zgartirildi" });
}
