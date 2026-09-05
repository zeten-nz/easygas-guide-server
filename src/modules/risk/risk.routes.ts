import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.middleware';
import { requirePermission } from '../../middleware/permission.middleware';
import { validate } from '../../middleware/validate.middleware';
import { requestMeta } from '../audit/audit.service';
import * as riskService from './risk.service';

/**
 * Mounted at /api/v1/jobs/:jobId/risks (mergeParams). All score/level/blocking
 * classification is server-computed (loyiha.md §21) — the client never sends a
 * level, score or blocking flag. Every mutation is branch-scoped, RBAC-guarded,
 * job-lock-serialized and audited. List is paginated.
 */
export const jobRiskRouter = Router({ mergeParams: true });
jobRiskRouter.use(requireAuth);

const jobParams = z.object({ jobId: z.coerce.number().int().positive() });
const riskParams = z.object({ jobId: z.coerce.number().int().positive(), riskId: z.coerce.number().int().positive() });

const createSchema = z.object({
  hazard: z.string().trim().min(2).max(80),
  description: z.string().trim().min(3).max(2000),
  severity: z.coerce.number().int().min(1).max(4),
  likelihood: z.coerce.number().int().min(1).max(4),
  jobStepId: z.coerce.number().int().positive().optional(),
  responsibleUserId: z.coerce.number().int().positive().optional(),
});
const resolveSchema = z.object({
  note: z.string().trim().min(3).max(2000),
  mitigation: z.string().trim().max(2000).optional(),
});
const reviseSchema = z.object({
  severity: z.coerce.number().int().min(1).max(4),
  likelihood: z.coerce.number().int().min(1).max(4),
  hazard: z.string().trim().min(2).max(80).optional(),
  description: z.string().trim().min(3).max(2000).optional(),
  reason: z.string().trim().min(3).max(500),
});
const overrideSchema = z.object({ reason: z.string().trim().min(3).max(500) });
const listQuery = z.object({
  cycle: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

jobRiskRouter.get('/', requirePermission('jobs.view'), validate({ params: jobParams, query: listQuery }), async (req: Request, res: Response) => {
  const result = await riskService.listRisks(req.user!, Number(req.params.jobId), {
    cycle: req.query.cycle ? Number(req.query.cycle) : undefined,
    page: req.query.page ? Number(req.query.page) : undefined,
    pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
  });
  res.json(result);
});

jobRiskRouter.post('/', requirePermission('risks.create'), validate({ params: jobParams, body: createSchema }), async (req: Request, res: Response) => {
  const { id } = await riskService.createRisk(req.user!, Number(req.params.jobId), req.body, requestMeta(req));
  res.status(201).json({ risk: { id } });
});

jobRiskRouter.post('/:riskId/resolve', requirePermission('risks.resolve'), validate({ params: riskParams, body: resolveSchema }), async (req: Request, res: Response) => {
  await riskService.resolveRisk(req.user!, Number(req.params.riskId), req.body, requestMeta(req));
  res.json({ message: 'Xavf hal qilindi' });
});

jobRiskRouter.post('/:riskId/revise', requirePermission('risks.resolve'), validate({ params: riskParams, body: reviseSchema }), async (req: Request, res: Response) => {
  const { id } = await riskService.reviseRisk(req.user!, Number(req.params.riskId), req.body, requestMeta(req));
  res.status(201).json({ risk: { id } });
});

jobRiskRouter.post('/:riskId/override', requirePermission('risks.override'), validate({ params: riskParams, body: overrideSchema }), async (req: Request, res: Response) => {
  await riskService.overrideRisk(req.user!, Number(req.params.riskId), req.body.reason, requestMeta(req));
  res.json({ message: 'Xavf override qilindi' });
});
