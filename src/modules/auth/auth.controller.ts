import type { CookieOptions, Request, Response } from 'express';
import { env, isProduction } from '../../config/env';
import { requestMeta } from '../audit/audit.service';
import * as authService from './auth.service';

function sessionCookieOptions(rememberMe: boolean, expiresAt: Date): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    // Without "remember me" the cookie is a browser-session cookie;
    // the server-side session still expires after SESSION_TTL_HOURS.
    ...(rememberMe ? { expires: expiresAt } : {}),
  };
}

export async function login(req: Request, res: Response): Promise<void> {
  const result = await authService.login(req.body, requestMeta(req));
  res.cookie(env.SESSION_COOKIE_NAME, result.token, sessionCookieOptions(result.rememberMe, result.expiresAt));
  res.json({ user: result.user });
}

export async function logout(req: Request, res: Response): Promise<void> {
  await authService.logout(req.cookies?.[env.SESSION_COOKIE_NAME], requestMeta(req));
  res.clearCookie(env.SESSION_COOKIE_NAME, { httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/' });
  res.status(204).end();
}

export async function me(req: Request, res: Response): Promise<void> {
  res.json({ user: req.user });
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
