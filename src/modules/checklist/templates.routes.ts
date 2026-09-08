import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requirePermission } from '../../middleware/permission.middleware';
import { validate } from '../../middleware/validate.middleware';
import { requestMeta } from '../audit/audit.service';
import {
  createTemplateSchema,
  moveStepSchema,
  stepParamsSchema,
  stepSchema,
  templateIdParamsSchema,
  versionParamsSchema,
} from './templates.validators';
import * as service from './templates.service';

export const checklistTemplatesRouter = Router();

checklistTemplatesRouter.use(requireAuth);

/**
 * Assignment picker for technicians (checklist.execute) — templates that have
 * a PUBLISHED version. Must precede /:id so "assignable" is not parsed as an id.
 */
checklistTemplatesRouter.get('/assignable', requirePermission('checklist.execute'), async (_req: Request, res: Response) => {
  res.json({ templates: await service.listAssignableTemplates() });
});

// All management operations are ADMIN-only via templates.manage (§4 matrix).
checklistTemplatesRouter.get('/', requirePermission('templates.manage'), async (_req: Request, res: Response) => {
  res.json({ templates: await service.listTemplates() });
});

checklistTemplatesRouter.get(
  '/:id',
  requirePermission('templates.manage'),
  validate({ params: templateIdParamsSchema }),
  async (req: Request, res: Response) => {
    res.json({ template: await service.getTemplate(Number(req.params.id)) });
  },
);

// §D permanently delete an UNUSED, DRAFT-only template. Eligibility is re-checked
// under a row lock in the service (a stable conflict, never a raw FK error, when
// the template has published/archived history or is referenced by a job).
checklistTemplatesRouter.delete(
  '/:id',
  requirePermission('templates.manage'),
  validate({ params: templateIdParamsSchema }),
  async (req: Request, res: Response) => {
    const deleted = await service.deleteTemplate(req.user!, Number(req.params.id), requestMeta(req));
    res.json({ deleted, message: `"${deleted.name}" shabloni o'chirildi` });
  },
);

checklistTemplatesRouter.post(
  '/',
  requirePermission('templates.manage'),
  validate({ body: createTemplateSchema }),
  async (req: Request, res: Response) => {
    const template = await service.createTemplate(req.user!, req.body, requestMeta(req));
    res.status(201).json({ template });
  },
);

checklistTemplatesRouter.post(
  '/:id/versions',
  requirePermission('templates.manage'),
  validate({ params: templateIdParamsSchema }),
  async (req: Request, res: Response) => {
    const template = await service.createVersion(req.user!, Number(req.params.id), requestMeta(req));
    res.status(201).json({ template });
  },
);

checklistTemplatesRouter.post(
  '/:id/versions/:versionId/steps',
  requirePermission('templates.manage'),
  validate({ params: versionParamsSchema, body: stepSchema }),
  async (req: Request, res: Response) => {
    const template = await service.addStep(
      req.user!,
      Number(req.params.id),
      Number(req.params.versionId),
      req.body,
      requestMeta(req),
    );
    res.status(201).json({ template });
  },
);

checklistTemplatesRouter.patch(
  '/:id/versions/:versionId/steps/:stepId',
  requirePermission('templates.manage'),
  validate({ params: stepParamsSchema, body: stepSchema }),
  async (req: Request, res: Response) => {
    const template = await service.updateStep(
      req.user!,
      Number(req.params.id),
      Number(req.params.versionId),
      Number(req.params.stepId),
      req.body,
      requestMeta(req),
    );
    res.json({ template });
  },
);

checklistTemplatesRouter.delete(
  '/:id/versions/:versionId/steps/:stepId',
  requirePermission('templates.manage'),
  validate({ params: stepParamsSchema }),
  async (req: Request, res: Response) => {
    const template = await service.deleteStep(
      req.user!,
      Number(req.params.id),
      Number(req.params.versionId),
      Number(req.params.stepId),
      requestMeta(req),
    );
    res.json({ template });
  },
);

checklistTemplatesRouter.post(
  '/:id/versions/:versionId/steps/:stepId/move',
  requirePermission('templates.manage'),
  validate({ params: stepParamsSchema, body: moveStepSchema }),
  async (req: Request, res: Response) => {
    const template = await service.moveStep(
      req.user!,
      Number(req.params.id),
      Number(req.params.versionId),
      Number(req.params.stepId),
      req.body.direction,
      requestMeta(req),
    );
    res.json({ template });
  },
);

checklistTemplatesRouter.post(
  '/:id/versions/:versionId/publish',
  requirePermission('templates.manage'),
  validate({ params: versionParamsSchema }),
  async (req: Request, res: Response) => {
    const template = await service.publishVersion(
      req.user!,
      Number(req.params.id),
      Number(req.params.versionId),
      requestMeta(req),
    );
    res.json({ template, message: 'Versiya nashr qilindi' });
  },
);

checklistTemplatesRouter.post(
  '/:id/versions/:versionId/archive',
  requirePermission('templates.manage'),
  validate({ params: versionParamsSchema }),
  async (req: Request, res: Response) => {
    const template = await service.archiveVersion(
      req.user!,
      Number(req.params.id),
      Number(req.params.versionId),
      requestMeta(req),
    );
    res.json({ template, message: 'Versiya arxivlandi' });
  },
);
