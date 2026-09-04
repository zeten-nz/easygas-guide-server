import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.middleware';
import { requirePermission } from '../../middleware/permission.middleware';
import { validate } from '../../middleware/validate.middleware';
import { requestMeta } from '../audit/audit.service';
import * as qualityService from './quality.service';
import * as completionService from '../jobs/completion.service';
import { getJob } from '../jobs/jobs.service';

const jobParamsSchema = z.object({
  jobId: z.coerce.number().int().positive(),
});

/**
 * Mounted at /api/v1/jobs/:jobId/quality (mergeParams).
 * Quality authority = jobs.reopen holders (SIFAT/ADMIN per §4). Inspection is
 * read-only; the only mutation here is the §24 QUALITY_REVIEW→COMPLETED
 * acceptance. Reopen itself lives at POST /jobs/:id/reopen.
 */
export const jobQualityRouter = Router({ mergeParams: true });

jobQualityRouter.use(requireAuth);

jobQualityRouter.get(
  '/',
  requirePermission('jobs.reopen'),
  validate({ params: jobParamsSchema }),
  async (req: Request, res: Response) => {
    const view = await qualityService.getQualityView(req.user!, Number(req.params.jobId));
    res.json(view);
  },
);

jobQualityRouter.post(
  '/confirm',
  requirePermission('jobs.reopen'),
  validate({ params: jobParamsSchema }),
  async (req: Request, res: Response) => {
    const jobId = Number(req.params.jobId);
    await completionService.confirmQuality(req.user!, jobId, requestMeta(req));
    const job = await getJob(req.user!, jobId);
    res.json({ job, message: "Sifat nazorati tasdiqlandi — ish yakunlandi" });
  },
);
