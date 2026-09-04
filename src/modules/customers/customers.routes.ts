import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requirePermission } from '../../middleware/permission.middleware';
import { validate } from '../../middleware/validate.middleware';
import { requestMeta } from '../audit/audit.service';
import {
  createCustomerSchema,
  customerIdParamsSchema,
  listCustomersQuerySchema,
  updateCustomerSchema,
} from './customers.validators';
import * as service from './customers.service';
import * as vehiclesService from '../vehicles/vehicles.service';
import type { ListCustomersQuery } from './customers.validators';

export const customersRouter = Router();

customersRouter.use(requireAuth);

customersRouter.get(
  '/',
  requirePermission('customers.view'),
  validate({ query: listCustomersQuerySchema }),
  async (req: Request, res: Response) => {
    const result = await service.listCustomers(req.query as unknown as ListCustomersQuery);
    res.json(result);
  },
);

customersRouter.get(
  '/:id',
  requirePermission('customers.view'),
  validate({ params: customerIdParamsSchema }),
  async (req: Request, res: Response) => {
    const customer = await service.getCustomer(Number(req.params.id));
    res.json({ customer });
  },
);

customersRouter.get(
  '/:id/vehicles',
  requirePermission('customers.view', 'vehicles.view'),
  validate({ params: customerIdParamsSchema }),
  async (req: Request, res: Response) => {
    // getCustomer 404s first so vehicle listing never leaks for bad IDs.
    const customer = await service.getCustomer(Number(req.params.id));
    const vehicles = await vehiclesService.listVehiclesOfCustomer(customer.id);
    res.json({ vehicles });
  },
);

customersRouter.post(
  '/',
  requirePermission('customers.manage'),
  validate({ body: createCustomerSchema }),
  async (req: Request, res: Response) => {
    const customer = await service.createCustomer(req.user!, req.body, requestMeta(req));
    res.status(201).json({ customer });
  },
);

customersRouter.patch(
  '/:id',
  requirePermission('customers.manage'),
  validate({ params: customerIdParamsSchema, body: updateCustomerSchema }),
  async (req: Request, res: Response) => {
    const customer = await service.updateCustomer(req.user!, Number(req.params.id), req.body, requestMeta(req));
    res.json({ customer });
  },
);
