import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { logger } from './utils/logger';
import { apiLimiter } from './middleware/rate-limit.middleware';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';
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

export function createApp() {
  const app = express();

  app.disable('x-powered-by');

  app.use(helmet());
  app.use(
    cors({
      origin: env.CLIENT_ORIGIN,
      credentials: true,
    }),
  );
  app.use(compression());
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === '/api/v1/health' },
    }),
  );

  app.get('/api/v1/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/api/v1', apiLimiter);
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/users', usersRouter);
  app.use('/api/v1/branches', branchesRouter);
  app.use('/api/v1/customers', customersRouter);
  app.use('/api/v1/vehicles', vehiclesRouter);
  app.use('/api/v1/jobs/:jobId/checklist/steps/:stepId/photos', stepPhotosRouter);
  app.use('/api/v1/jobs/:jobId/checklist', jobChecklistRouter);
  app.use('/api/v1/jobs/:jobId/stop', jobStopRouter);
  app.use('/api/v1/jobs/:jobId/quality', jobQualityRouter);
  app.use('/api/v1/jobs', jobsRouter);
  app.use('/api/v1/checklist-templates', checklistTemplatesRouter);
  app.use('/api/v1/admin/registration-requests', registrationAdminRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
