import { Router } from 'express';
import { validate } from '../../middleware/validate.middleware';
import { requireAuth } from '../../middleware/auth.middleware';
import {
  loginIpLimiter,
  loginPhoneLimiter,
  registerLimiter,
  changePasswordLimiter,
} from '../../middleware/rate-limit.middleware';
import { loginSchema, registerSchema, changePasswordSchema } from './auth.validators';
import * as controller from './auth.controller';

export const authRouter = Router();

authRouter.post('/login', loginIpLimiter, loginPhoneLimiter, validate({ body: loginSchema }), controller.login);
authRouter.post('/logout', controller.logout);
authRouter.get('/me', requireAuth, controller.me);
authRouter.post('/register', registerLimiter, validate({ body: registerSchema }), controller.register);
// §D — self password change. requireAuth first so the limiter/gate see req.user;
// the first-login gate (auth.middleware) allowlists this route so a temporary-
// password session can reach it while every business API stays blocked.
authRouter.post(
  '/change-password',
  requireAuth,
  changePasswordLimiter,
  validate({ body: changePasswordSchema }),
  controller.changePassword,
);
