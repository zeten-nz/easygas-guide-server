import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.middleware';
import { requirePermission } from '../../middleware/permission.middleware';
import { validate } from '../../middleware/validate.middleware';
import { requestMeta } from '../audit/audit.service';
import * as gpsService from './gps.service';
import { GPS_PURPOSES } from './gps.service';

/**
 * Mounted at /api/v1/jobs/:jobId/gps (mergeParams). GPS is client-reported
 * evidence — the SERVER validates ranges/accuracy/age and records both client
 * and server timestamps (loyiha.md §20). Capture: any checklist executor.
 * Override (unavailable GPS): gps.override + reason.
 */
export const jobGpsRouter = Router({ mergeParams: true });
jobGpsRouter.use(requireAuth);

const jobParams = z.object({ jobId: z.coerce.number().int().positive() });
const captureSchema = z.object({
  latitude: z.coerce.number(),
  longitude: z.coerce.number(),
  accuracy: z.coerce.number(),
  clientTimestamp: z.union([z.string(), z.number()]),
  purpose: z.enum(GPS_PURPOSES).optional(),
});
const overrideSchema = z.object({ purpose: z.enum(GPS_PURPOSES).optional(), reason: z.string().trim().min(3).max(500) });

jobGpsRouter.get('/', requirePermission('jobs.view'), validate({ params: jobParams }), async (req: Request, res: Response) => {
  res.json(await gpsService.listGps(req.user!, Number(req.params.jobId)));
});

jobGpsRouter.post('/', requirePermission('checklist.execute'), validate({ params: jobParams, body: captureSchema }), async (req: Request, res: Response) => {
  const { id } = await gpsService.captureGps(req.user!, Number(req.params.jobId), req.body, requestMeta(req));
  res.status(201).json({ gps: { id }, message: 'GPS qabul qilindi' });
});

jobGpsRouter.post('/override', requirePermission('gps.override'), validate({ params: jobParams, body: overrideSchema }), async (req: Request, res: Response) => {
  const { id } = await gpsService.overrideGps(req.user!, Number(req.params.jobId), req.body.purpose ?? 'JOB_START', req.body.reason, requestMeta(req));
  res.status(201).json({ gps: { id }, message: 'GPS override qayd etildi' });
});
