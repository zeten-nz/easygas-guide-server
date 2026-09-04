import { Router } from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
import { requireAuth } from '../../middleware/auth.middleware';
import { requirePermission } from '../../middleware/permission.middleware';
import { validate } from '../../middleware/validate.middleware';
import { requestMeta } from '../audit/audit.service';
import {
  cancelJobSchema,
  createJobSchema,
  installationSchema,
  jobIdParamsSchema,
  listJobsQuerySchema,
} from './jobs.validators';
import * as service from './jobs.service';
import * as completionService from './completion.service';
import { ApiError } from '../../utils/errors';
import type { ListJobsQuery } from './jobs.validators';

const signatureUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

/**
 * Jobs are NOT generic CRUD:
 * - no generic PATCH (core identity is immutable; status moves only through
 *   the explicit transition endpoints below),
 * - no DELETE (service history is permanent).
 */
export const jobsRouter = Router();

jobsRouter.use(requireAuth);

jobsRouter.get(
  '/',
  requirePermission('jobs.view'),
  validate({ query: listJobsQuerySchema }),
  async (req: Request, res: Response) => {
    const result = await service.listJobs(req.user!, req.query as unknown as ListJobsQuery);
    res.json(result);
  },
);

jobsRouter.get(
  '/:id',
  requirePermission('jobs.view'),
  validate({ params: jobIdParamsSchema }),
  async (req: Request, res: Response) => {
    const job = await service.getJob(req.user!, Number(req.params.id));
    res.json({ job });
  },
);

jobsRouter.post(
  '/',
  requirePermission('jobs.create'),
  validate({ body: createJobSchema }),
  async (req: Request, res: Response) => {
    const job = await service.createJob(req.user!, req.body, requestMeta(req));
    res.status(201).json({ job });
  },
);

jobsRouter.post(
  '/:id/start',
  requirePermission('jobs.create'),
  validate({ params: jobIdParamsSchema }),
  async (req: Request, res: Response) => {
    const job = await service.startJob(req.user!, Number(req.params.id), requestMeta(req));
    res.json({ job, message: 'Ish boshlandi' });
  },
);

/**
 * Dedicated §13 installation endpoint — NOT a generic job PATCH: only the
 * installation fields are writable, and only while DRAFT/IN_PROGRESS.
 */
jobsRouter.patch(
  '/:id/installation',
  requirePermission('jobs.create'),
  validate({ params: jobIdParamsSchema, body: installationSchema }),
  async (req: Request, res: Response) => {
    const job = await service.updateInstallation(req.user!, Number(req.params.id), req.body, requestMeta(req));
    res.json({ job, message: "O'rnatish ma'lumotlari saqlandi" });
  },
);

/**
 * §22–23 completion flow. Explicit endpoints only — status, actors and
 * timestamps are always server-derived; the completion gate runs inside the
 * close transaction and cannot be bypassed by any client-sent flags.
 */
jobsRouter.get(
  '/:id/completion',
  requirePermission('jobs.view'),
  validate({ params: jobIdParamsSchema }),
  async (req: Request, res: Response) => {
    const jobId = Number(req.params.id);
    const job = await service.getJob(req.user!, jobId); // branch scope (404)
    const readiness = await completionService.validateJobCompletion(jobId);
    const signature = await completionService.getSignature(req.user!, jobId);
    res.json({ readiness, signature, jobStatus: job.status });
  },
);

jobsRouter.post(
  '/:id/signature',
  requirePermission('checklist.execute'),
  validate({ params: jobIdParamsSchema }),
  signatureUpload.single('signature'),
  async (req: Request, res: Response) => {
    if (!req.file) {
      throw new ApiError(422, 'NO_FILE', "Imzo fayli yuborilmadi ('signature' maydoni)");
    }
    const signature = await completionService.saveSignature(
      req.user!,
      Number(req.params.id),
      { buffer: req.file.buffer },
      requestMeta(req),
    );
    res.status(201).json({ signature, message: 'Mijoz imzosi saqlandi' });
  },
);

jobsRouter.get(
  '/:id/signature/file',
  requirePermission('jobs.view'),
  validate({ params: jobIdParamsSchema }),
  async (req: Request, res: Response) => {
    const { stream, mimeType, sizeBytes } = await completionService.getSignatureStream(req.user!, Number(req.params.id));
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', String(sizeBytes));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `inline; filename="signature-${req.params.id}"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    stream.on('error', () => {
      if (!res.headersSent) res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Imzo topilmadi' } });
      else res.destroy();
    });
    stream.pipe(res);
  },
);

jobsRouter.post(
  '/:id/complete',
  requirePermission('jobs.close'),
  validate({ params: jobIdParamsSchema }),
  async (req: Request, res: Response) => {
    const jobId = Number(req.params.id);
    await completionService.closeJob(req.user!, jobId, requestMeta(req));
    const job = await service.getJob(req.user!, jobId);
    res.json({ job, message: 'Ish muvaffaqiyatli yakunlandi' });
  },
);

/** §24: COMPLETED → REOPENED with a mandatory persisted reason (SIFAT/ADMIN). */
jobsRouter.post(
  '/:id/reopen',
  requirePermission('jobs.reopen'),
  validate({ params: jobIdParamsSchema, body: cancelJobSchema }),
  async (req: Request, res: Response) => {
    const jobId = Number(req.params.id);
    await completionService.reopenJob(req.user!, jobId, req.body.reason, requestMeta(req));
    const job = await service.getJob(req.user!, jobId);
    res.json({ job, message: 'Ish qayta ochildi — tuzatish jarayoni boshlandi' });
  },
);

jobsRouter.post(
  '/:id/cancel',
  requirePermission('jobs.create'),
  validate({ params: jobIdParamsSchema, body: cancelJobSchema }),
  async (req: Request, res: Response) => {
    const job = await service.cancelJob(req.user!, Number(req.params.id), req.body.reason, requestMeta(req));
    res.json({ job, message: 'Ish bekor qilindi' });
  },
);
