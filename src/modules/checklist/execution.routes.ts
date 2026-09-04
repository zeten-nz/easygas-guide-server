import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.middleware';
import { requirePermission } from '../../middleware/permission.middleware';
import { validate } from '../../middleware/validate.middleware';
import { requestMeta } from '../audit/audit.service';
import * as service from './execution.service';

const jobParamsSchema = z.object({
  jobId: z.coerce.number().int().positive(),
});

const stepParamsSchema = z.object({
  jobId: z.coerce.number().int().positive(),
  stepId: z.coerce.number().int().positive(),
});

/**
 * The client may only pick a TEMPLATE — the applied version is always the
 * server-resolved current PUBLISHED one (any versionId in the body is stripped).
 */
const assignSchema = z.object({
  templateId: z.number().int().positive('Shablon tanlanishi shart'),
});

const completeSchema = z.object({
  note: z.string().trim().max(1000).nullable().optional(),
  measurements: z
    .array(
      z.object({
        measurementId: z.number().int().positive(),
        value: z.number().finite(),
      }),
    )
    .max(20)
    .optional()
    .default([]),
});

/** Mounted at /api/v1/jobs/:jobId/checklist (mergeParams). */
export const jobChecklistRouter = Router({ mergeParams: true });

jobChecklistRouter.use(requireAuth);

jobChecklistRouter.get(
  '/',
  requirePermission('jobs.view'),
  validate({ params: jobParamsSchema }),
  async (req: Request, res: Response) => {
    const checklist = await service.getJobChecklist(req.user!, Number(req.params.jobId));
    res.json({ checklist });
  },
);

jobChecklistRouter.post(
  '/',
  requirePermission('checklist.execute'),
  validate({ params: jobParamsSchema, body: assignSchema }),
  async (req: Request, res: Response) => {
    const checklist = await service.assignChecklist(
      req.user!,
      Number(req.params.jobId),
      req.body.templateId,
      requestMeta(req),
    );
    res.status(201).json({ checklist, message: 'Checklist biriktirildi' });
  },
);

jobChecklistRouter.post(
  '/steps/:stepId/complete',
  requirePermission('checklist.execute'),
  validate({ params: stepParamsSchema, body: completeSchema }),
  async (req: Request, res: Response) => {
    const checklist = await service.completeStep(
      req.user!,
      Number(req.params.jobId),
      Number(req.params.stepId),
      req.body,
      requestMeta(req),
    );
    res.json({ checklist, message: 'Bosqich bajarildi' });
  },
);

/** §24 correction: re-open a done step as a new attempt (REOPENED jobs only). */
jobChecklistRouter.post(
  '/steps/:stepId/redo',
  requirePermission('checklist.execute'),
  validate({ params: stepParamsSchema }),
  async (req: Request, res: Response) => {
    const checklist = await service.redoStep(
      req.user!,
      Number(req.params.jobId),
      Number(req.params.stepId),
      requestMeta(req),
    );
    res.json({ checklist, message: 'Bosqich tuzatish uchun qayta ochildi' });
  },
);
