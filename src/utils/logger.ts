import pino from 'pino';
import { env } from '../config/env';

/**
 * Secret-hygiene redaction (Phase 10A + 10C). Session cookies, CSRF tokens, OTP
 * codes, phone numbers, Redis URLs, S3/Eskiz credentials and Authorization /
 * bearer headers must never reach the logs. Exported so a test asserts the same
 * config actually censors these fields.
 */
export const redactPaths = [
  // Request/response headers
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  'res.headers["x-csrf-token"]',
  // Request bodies
  'req.body.password',
  'req.body.otp',
  'req.body.phone',
  'req.body.resetToken',
  'req.body.ESKIZ_PASSWORD',
  // Generic field names anywhere they appear at the top level of a log object
  'password',
  'otp',
  'token',
  'resetToken',
  'csrfToken',
  'accessToken',
  'authorization',
  'REDIS_URL',
  'ESKIZ_PASSWORD',
  'S3_SECRET_ACCESS_KEY',
  'S3_ACCESS_KEY_ID',
  'METRICS_TOKEN',
  // Phase 10F: safety-sensitive payloads + PII must never reach logs.
  'phone',
  'signature',
  'latitude',
  'longitude',
  'gps',
  'coordinates',
  // Nested one level (e.g. { config: { password } })
  '*.password',
  '*.token',
  '*.otp',
  '*.authorization',
  '*.phone',
  '*.signature',
  '*.latitude',
  '*.longitude',
  '*.coordinates',
];

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'warn' : 'info',
  redact: {
    paths: redactPaths,
    censor: '[redacted]',
  },
});
