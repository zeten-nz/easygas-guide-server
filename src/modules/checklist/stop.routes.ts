import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.middleware';
import { requirePermission } from '../../middleware/permission.middleware';
import { validate } from '../../middleware/validate.middleware';
import { requestMeta } from '../audit/audit.service';
import * as stopService from './stop.service';
import * as executionService from './execution.service';

const jobParamsSchema = z.object({
  jobId: z.coerce.number().int().positive(),
});

const rejectSchema = z.object({
  reason: z.string().trim().min(3, "Rad etish sababi ko'rsatilishi shart").max(500),
});

/**
 * Mounted at /api/v1/jobs/:jobId/stop (mergeParams).
 * Decisions are MASTER-only via stops.approve (§4 matrix — ADMIN deliberately
 * has no decision right). All state (status, actors, timestamps) is
 * server-controlled; request bodies carry only the rejection reason.
 * No PATCH/DELETE surface exists — STOP history is immutable.
 */
export const jobStopRouter = Router({ mergeParams: true });

jobStopRouter.use(requireAuth);

jobStopRouter.get(
  '/',
  requirePermission('jobs.view'),
  validate({ params: jobParamsSchema }),
  async (req: Request, res: Response) => {
    const approvals = await stopService.getJobStopApprovals(req.user!, Number(req.params.jobId));
    res.json({ approvals });
  },
);

jobStopRouter.post(
  '/approve',
  requirePermission('stops.approve'),
  validate({ params: jobParamsSchema }),
  async (req: Request, res: Response) => {
    const jobId = Number(req.params.jobId);
    await stopService.approveStop(req.user!, jobId, requestMeta(req));
    const checklist = await executionService.getJobChecklist(req.user!, jobId);
    res.json({ checklist, message: 'STOP tasdiqlandi — ish davom etishi mumkin' });
  },
);

jobStopRouter.post(
  '/rework',
  requirePermission('checklist.execute'),
  validate({ params: jobParamsSchema }),
  async (req: Request, res: Response) => {
    const jobId = Number(req.params.jobId);
    await stopService.reworkStop(req.user!, jobId, requestMeta(req));
    const checklist = await executionService.getJobChecklist(req.user!, jobId);
    res.json({ checklist, message: 'Tuzatish boshlandi — bosqichni qayta bajaring va yuboring' });
  },
);

jobStopRouter.post(
  '/reject',
  requirePermission('stops.approve'),
  validate({ params: jobParamsSchema, body: rejectSchema }),
  async (req: Request, res: Response) => {
    const jobId = Number(req.params.jobId);
    await stopService.rejectStop(req.user!, jobId, req.body.reason, requestMeta(req));
    const checklist = await executionService.getJobChecklist(req.user!, jobId);
    res.json({ checklist, message: 'STOP rad etildi' });
  },
);
