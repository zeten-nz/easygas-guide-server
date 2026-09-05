import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.middleware';
import { requirePermission } from '../../middleware/permission.middleware';
import { validate } from '../../middleware/validate.middleware';
import { requestMeta } from '../audit/audit.service';
import * as policy from './risk-policy.service';

/**
 * Mounted at /api/v1/risk-policy. Governance is restricted to
 * `risk.matrix.approve` (SIFAT/ADMIN). A normal caller cannot submit arbitrary
 * matrix JSON and activate it in one step — create (DRAFT) and activate are
 * separate, and activation requires a rationale.
 */
export const riskPolicyRouter = Router();
riskPolicyRouter.use(requireAuth);

// Any authenticated user may read whether a policy is active (drives the
// completion-readiness/warning UI) — no matrix internals are exposed here.
riskPolicyRouter.get('/', async (_req: Request, res: Response) => {
  const active = await policy.getActiveMatrix();
  res.json({ active: active !== null, version: active?.version ?? null });
});

// Full version list (DRAFT/ACTIVE/RETIRED + thresholds) for the admin screen.
riskPolicyRouter.get('/versions', async (req: Request, res: Response) => {
  res.json({ versions: await policy.listMatrices(req.user!) });
});

const createSchema = z.object({ version: z.string().trim().min(1).max(32), definition: z.record(z.string(), z.unknown()) });
riskPolicyRouter.post('/versions', requirePermission('risk.matrix.approve'), validate({ body: createSchema }), async (req: Request, res: Response) => {
  const r = await policy.createMatrixVersion(req.user!, req.body.version, req.body.definition, requestMeta(req));
  res.status(201).json({ version: r.version, status: 'DRAFT' });
});

const versionParams = z.object({ version: z.string().trim().min(1).max(32) });
const activateSchema = z.object({ rationale: z.string().trim().min(3).max(1000) });
riskPolicyRouter.post('/:version/activate', requirePermission('risk.matrix.approve'), validate({ params: versionParams, body: activateSchema }), async (req: Request, res: Response) => {
  await policy.activateMatrix(req.user!, String(req.params.version), req.body.rationale, requestMeta(req));
  res.json({ message: 'Xavf matritsasi faollashtirildi', version: String(req.params.version) });
});

riskPolicyRouter.post('/:version/retire', requirePermission('risk.matrix.approve'), validate({ params: versionParams }), async (req: Request, res: Response) => {
  await policy.retireMatrix(req.user!, String(req.params.version), requestMeta(req));
  res.json({ message: 'Matritsa chiqarib tashlandi', version: String(req.params.version) });
});
