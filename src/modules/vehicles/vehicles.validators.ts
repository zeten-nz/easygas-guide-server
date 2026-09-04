import { z } from 'zod';
import { normalizePlate, normalizeVin } from '../../utils/vehicle';

const CURRENT_YEAR = new Date().getFullYear();

const plateSchema = z
  .string()
  .min(1, "Davlat raqami kiritilishi shart")
  .transform((v, ctx) => {
    const normalized = normalizePlate(v);
    if (!normalized) {
      ctx.addIssue({ code: 'custom', message: "Davlat raqami noto'g'ri formatda" });
      return z.NEVER;
    }
    return normalized;
  });

const vinSchema = z
  .string()
  .transform((v, ctx) => {
    const normalized = normalizeVin(v);
    if (!normalized) {
      ctx.addIssue({ code: 'custom', message: "VIN 17 ta belgidan iborat bo'lishi kerak (I, O, Q harflarisiz)" });
      return z.NEVER;
    }
    return normalized;
  });

const vehicleFields = {
  plateNumber: plateSchema,
  vin: vinSchema.nullable().optional(),
  make: z.string().trim().min(2, 'Marka kiritilishi shart').max(50),
  model: z.string().trim().min(1, 'Model kiritilishi shart').max(50),
  year: z
    .number()
    .int()
    .min(1950, "Yil noto'g'ri")
    .max(CURRENT_YEAR + 1, "Yil noto'g'ri")
    .nullable()
    .optional(),
  engine: z.string().trim().max(100).nullable().optional(),
  mileage: z.number().int().min(0).max(2_000_000, "Probeg noto'g'ri").nullable().optional(),
};

export const listVehiclesQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  customerId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const vehicleIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const createVehicleSchema = z.object({
  customerId: z.number().int().positive('Mijoz tanlanishi shart'),
  ...vehicleFields,
});

export const updateVehicleSchema = z
  .object({
    customerId: z.number().int().positive().optional(),
    plateNumber: plateSchema.optional(),
    vin: vehicleFields.vin,
    make: vehicleFields.make.optional(),
    model: vehicleFields.model.optional(),
    year: vehicleFields.year,
    engine: vehicleFields.engine,
    mileage: vehicleFields.mileage,
  })
  .refine((v) => Object.keys(v).length > 0, { message: "O'zgartirish uchun maydon berilmadi" });

export type ListVehiclesQuery = z.infer<typeof listVehiclesQuerySchema>;
export type CreateVehicleInput = z.infer<typeof createVehicleSchema>;
export type UpdateVehicleInput = z.infer<typeof updateVehicleSchema>;
