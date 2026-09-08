import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requirePermission } from '../../middleware/permission.middleware';
import { validate } from '../../middleware/validate.middleware';
import { requestMeta } from '../audit/audit.service';
import {
  createInjectionSchema,
  injectionIdParamsSchema,
  listInjectionQuerySchema,
  updateInjectionSchema,
  type ListInjectionQuery,
} from './injection.validators';
import * as service from './injection.service';

export const injectionRouter = Router();

injectionRouter.get(
  '/',
  requireAuth,
  requirePermission('catalog.view'),
  validate({ query: listInjectionQuerySchema }),
  async (req: Request, res: Response) => {
    res.json(await service.listInjection(req.query as unknown as ListInjectionQuery));
  },
);

injectionRouter.get(
  '/:id',
  requireAuth,
  requirePermission('catalog.view'),
  validate({ params: injectionIdParamsSchema }),
  async (req: Request, res: Response) => {
    res.json({ item: await service.getInjection(Number(req.params.id)) });
  },
);

injectionRouter.post(
  '/',
  requireAuth,
  requirePermission('catalog.manage'),
  validate({ body: createInjectionSchema }),
  async (req: Request, res: Response) => {
    const item = await service.createInjection(req.user!, req.body, requestMeta(req));
    res.status(201).json({ item });
  },
);

injectionRouter.patch(
  '/:id',
  requireAuth,
  requirePermission('catalog.manage'),
  validate({ params: injectionIdParamsSchema, body: updateInjectionSchema }),
  async (req: Request, res: Response) => {
    const item = await service.updateInjection(req.user!, Number(req.params.id), req.body, requestMeta(req));
    res.json({ item });
  },
);

injectionRouter.post(
  '/:id/archive',
  requireAuth,
  requirePermission('catalog.manage'),
  validate({ params: injectionIdParamsSchema }),
  async (req: Request, res: Response) => {
    const item = await service.setInjectionStatus(req.user!, Number(req.params.id), 'ARCHIVED', requestMeta(req));
    res.json({ item, message: 'Arxivlandi' });
  },
);

injectionRouter.post(
  '/:id/reactivate',
  requireAuth,
  requirePermission('catalog.manage'),
  validate({ params: injectionIdParamsSchema }),
  async (req: Request, res: Response) => {
    const item = await service.setInjectionStatus(req.user!, Number(req.params.id), 'ACTIVE', requestMeta(req));
    res.json({ item, message: 'Faollashtirildi' });
  },
);

injectionRouter.delete(
  '/:id',
  requireAuth,
  requirePermission('catalog.manage'),
  validate({ params: injectionIdParamsSchema }),
  async (req: Request, res: Response) => {
    const result = await service.deleteInjection(req.user!, Number(req.params.id), requestMeta(req));
    res.json({ ...result, message: "O'chirildi" });
  },
);
