import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requirePermission } from '../../middleware/permission.middleware';
import { validate } from '../../middleware/validate.middleware';
import { requestMeta } from '../audit/audit.service';
import {
  createVehicleSchema,
  listVehiclesQuerySchema,
  updateVehicleSchema,
  vehicleIdParamsSchema,
} from './vehicles.validators';
import * as service from './vehicles.service';
import type { ListVehiclesQuery } from './vehicles.validators';

export const vehiclesRouter = Router();

vehiclesRouter.use(requireAuth);

vehiclesRouter.get(
  '/',
  requirePermission('vehicles.view'),
  validate({ query: listVehiclesQuerySchema }),
  async (req: Request, res: Response) => {
    const result = await service.listVehicles(req.query as unknown as ListVehiclesQuery);
    res.json(result);
  },
);

vehiclesRouter.get(
  '/:id',
  requirePermission('vehicles.view'),
  validate({ params: vehicleIdParamsSchema }),
  async (req: Request, res: Response) => {
    const vehicle = await service.getVehicle(Number(req.params.id));
    res.json({ vehicle });
  },
);

vehiclesRouter.post(
  '/',
  requirePermission('vehicles.manage'),
  validate({ body: createVehicleSchema }),
  async (req: Request, res: Response) => {
    const vehicle = await service.createVehicle(req.user!, req.body, requestMeta(req));
    res.status(201).json({ vehicle });
  },
);

vehiclesRouter.patch(
  '/:id',
  requirePermission('vehicles.manage'),
  validate({ params: vehicleIdParamsSchema, body: updateVehicleSchema }),
  async (req: Request, res: Response) => {
    const vehicle = await service.updateVehicle(req.user!, Number(req.params.id), req.body, requestMeta(req));
    res.json({ vehicle });
  },
);
