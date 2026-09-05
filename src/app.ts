import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { logger } from './utils/logger';
import { apiLimiter } from './middleware/rate-limit.middleware';
import { csrfProtection } from './middleware/csrf.middleware';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';
import { readiness } from './modules/health/health.service';
import { authRouter } from './modules/auth/auth.routes';
import { branchesRouter } from './modules/branches/branches.routes';
import { registrationAdminRouter } from './modules/users/registration.admin.routes';
import { usersRouter } from './modules/users/users.routes';
import { customersRouter } from './modules/customers/customers.routes';
import { vehiclesRouter } from './modules/vehicles/vehicles.routes';
import { jobsRouter } from './modules/jobs/jobs.routes';
import { checklistTemplatesRouter } from './modules/checklist/templates.routes';
import { jobChecklistRouter } from './modules/checklist/execution.routes';
import { jobStopRouter } from './modules/checklist/stop.routes';
import { stepPhotosRouter } from './modules/photos/photos.routes';
import { jobQualityRouter } from './modules/quality/quality.routes';
import { jobRiskRouter } from './modules/risk/risk.routes';
import { riskPolicyRouter } from './modules/risk/risk-policy.routes';
import { jobGpsRouter } from './modules/gps/gps.routes';

export interface CreateAppOptions {
  /** Overrides env.TRUST_PROXY_HOPS (used by tests to exercise both modes). */
  trustProxyHops?: number;
}

export function createApp(options: CreateAppOptions = {}) {
  const app = express();

  app.disable('x-powered-by');

  // Reverse-proxy trust (Phase 10A): 0 = X-Forwarded-For is NEVER trusted
  // (safe development default — req.ip is the socket address); N = exactly N
  // trusted proxies (production: 1 for the single Nginx in front). Audit-log
  // IPs and rate-limit keys both derive from req.ip.
  const trustProxyHops = options.trustProxyHops ?? env.TRUST_PROXY_HOPS;
  app.set('trust proxy', trustProxyHops > 0 ? trustProxyHops : false);

  app.use(helmet());
  app.use(
    cors({
      origin: env.CLIENT_ORIGIN,
      credentials: true,
      // Phase 10C: the SPA reads the rotated CSRF token + its monotonic sequence
      // (and rate-limit headers) from responses; these must be exposed to JS.
      exposedHeaders: ['x-csrf-token', 'x-session-rotation', 'Retry-After', 'RateLimit-Limit', 'RateLimit-Remaining'],
    }),
  );
  app.use(compression());
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === '/api/v1/health' || req.url === '/api/v1/ready' },
    }),
  );

  // Liveness (Phase 10C): minimal, no external dependencies. Used by PM2/orchestrator.
  app.get('/api/v1/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Readiness (Phase 10C): checks DB/Redis/storage/SMS-config with strict
  // timeouts and flips to 503 during graceful shutdown. Used by Nginx to decide
  // whether to route traffic here.
  app.get('/api/v1/ready', async (_req, res) => {
    const r = await readiness();
    res.status(r.ready ? 200 : 503).json({ status: r.ready ? 'ready' : 'not_ready', checks: r.checks });
  });

  app.use('/api/v1', apiLimiter);
  // CSRF (Phase 10A): every state-changing request under /api/v1 passes
  // origin screening; every cookie-bearing one additionally needs the
  // session-bound x-csrf-token header. Mounted before all routers — no route
  // can be added without protection.
  app.use('/api/v1', csrfProtection);
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/users', usersRouter);
  app.use('/api/v1/branches', branchesRouter);
  app.use('/api/v1/customers', customersRouter);
  app.use('/api/v1/vehicles', vehiclesRouter);
  app.use('/api/v1/jobs/:jobId/checklist/steps/:stepId/photos', stepPhotosRouter);
  app.use('/api/v1/jobs/:jobId/checklist', jobChecklistRouter);
  app.use('/api/v1/jobs/:jobId/stop', jobStopRouter);
  app.use('/api/v1/jobs/:jobId/risks', jobRiskRouter);
  app.use('/api/v1/jobs/:jobId/gps', jobGpsRouter);
  app.use('/api/v1/jobs/:jobId/quality', jobQualityRouter);
  app.use('/api/v1/jobs', jobsRouter);
  app.use('/api/v1/checklist-templates', checklistTemplatesRouter);
  app.use('/api/v1/risk-policy', riskPolicyRouter);
  app.use('/api/v1/admin/registration-requests', registrationAdminRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
