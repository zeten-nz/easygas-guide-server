import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requirePermission } from '../../middleware/permission.middleware';
import { validate } from '../../middleware/validate.middleware';
import { requestMeta } from '../audit/audit.service';
import {
  createServiceSchema,
  listServicesQuerySchema,
  serviceIdParamsSchema,
  updateServiceSchema,
  type ListServicesQuery,
} from './services.validators';
import { getPriceHistory } from './products.service';
import * as service from './services.service';

export const servicesRouter = Router();

servicesRouter.get(
  '/',
  requireAuth,
  requirePermission('catalog.view'),
  validate({ query: listServicesQuerySchema }),
  async (req: Request, res: Response) => {
    res.json(await service.listServices(req.query as unknown as ListServicesQuery));
  },
);

servicesRouter.get(
  '/:id',
  requireAuth,
  requirePermission('catalog.view'),
  validate({ params: serviceIdParamsSchema }),
  async (req: Request, res: Response) => {
    res.json({ service: await service.getService(Number(req.params.id)) });
  },
);

servicesRouter.get(
  '/:id/price-history',
  requireAuth,
  requirePermission('catalog.view'),
  validate({ params: serviceIdParamsSchema }),
  async (req: Request, res: Response) => {
    await service.getService(Number(req.params.id));
    res.json({ history: await getPriceHistory('service', Number(req.params.id)) });
  },
);

servicesRouter.post(
  '/',
  requireAuth,
  requirePermission('catalog.manage'),
  validate({ body: createServiceSchema }),
  async (req: Request, res: Response) => {
    const created = await service.createService(req.user!, req.body, requestMeta(req));
    res.status(201).json({ service: created });
  },
);

servicesRouter.patch(
  '/:id',
  requireAuth,
  requirePermission('catalog.manage'),
  validate({ params: serviceIdParamsSchema, body: updateServiceSchema }),
  async (req: Request, res: Response) => {
    const updated = await service.updateService(req.user!, Number(req.params.id), req.body, requestMeta(req));
    res.json({ service: updated });
  },
);

servicesRouter.post(
  '/:id/archive',
  requireAuth,
  requirePermission('catalog.manage'),
  validate({ params: serviceIdParamsSchema }),
  async (req: Request, res: Response) => {
    const updated = await service.setServiceStatus(req.user!, Number(req.params.id), 'ARCHIVED', requestMeta(req));
    res.json({ service: updated, message: 'Xizmat arxivlandi' });
  },
);

servicesRouter.post(
  '/:id/reactivate',
  requireAuth,
  requirePermission('catalog.manage'),
  validate({ params: serviceIdParamsSchema }),
  async (req: Request, res: Response) => {
    const updated = await service.setServiceStatus(req.user!, Number(req.params.id), 'ACTIVE', requestMeta(req));
    res.json({ service: updated, message: 'Xizmat faollashtirildi' });
  },
);

servicesRouter.delete(
  '/:id',
  requireAuth,
  requirePermission('catalog.manage'),
  validate({ params: serviceIdParamsSchema }),
  async (req: Request, res: Response) => {
    const result = await service.deleteService(req.user!, Number(req.params.id), requestMeta(req));
    res.json({ ...result, message: "Xizmat o'chirildi" });
  },
);
