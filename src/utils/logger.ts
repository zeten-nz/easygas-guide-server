import pino from 'pino';
import { env } from '../config/env';

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'warn' : 'info',
  // OTP codes, passwords, session cookies and tokens must never reach the logs.
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'res.headers["set-cookie"]',
      'password',
      'otp',
      'token',
    ],
    censor: '[redacted]',
  },
});
