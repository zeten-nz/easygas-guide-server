import { Router } from 'express';
import { validate } from '../../middleware/validate.middleware';
import { requireAuth } from '../../middleware/auth.middleware';
import {
  loginIpLimiter,
  loginPhoneLimiter,
  registerLimiter,
  otpRequestIpLimiter,
  otpRequestPhoneLimiter,
  otpVerifyLimiter,
  resetPasswordLimiter,
} from '../../middleware/rate-limit.middleware';
import {
  loginSchema,
  registerSchema,
  forgotPasswordSchema,
  verifyOtpSchema,
  resetPasswordSchema,
} from './auth.validators';
import * as controller from './auth.controller';

export const authRouter = Router();

authRouter.post('/login', loginIpLimiter, loginPhoneLimiter, validate({ body: loginSchema }), controller.login);
authRouter.post('/logout', controller.logout);
authRouter.get('/me', requireAuth, controller.me);
authRouter.post('/register', registerLimiter, validate({ body: registerSchema }), controller.register);
authRouter.post(
  '/forgot-password',
  otpRequestIpLimiter,
  otpRequestPhoneLimiter,
  validate({ body: forgotPasswordSchema }),
  controller.forgotPassword,
);
authRouter.post('/verify-otp', otpVerifyLimiter, validate({ body: verifyOtpSchema }), controller.verifyOtp);
authRouter.post(
  '/reset-password',
  resetPasswordLimiter,
  validate({ body: resetPasswordSchema }),
  controller.resetPassword,
);
