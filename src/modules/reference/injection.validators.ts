import { z } from 'zod';

const designation = z.string().trim().min(1, 'Belgilanish kiritilishi shart').max(60);
const technology = z.enum(['PORT_MULTIPOINT', 'DIRECT', 'UNKNOWN']);
const forcedInduction = z.enum(['NONE', 'TURBO', 'SUPERCHARGED', 'UNKNOWN']);
const description = z.string().trim().max(500).nullable();

export const listInjectionQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(150).optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  technology: technology.optional(),
});

export const createInjectionSchema = z.object({
  designation,
  technology: technology.optional(),
  forcedInduction: forcedInduction.optional(),
  description: description.optional(),
});

export const updateInjectionSchema = z
  .object({
    designation: designation.optional(),
    technology: technology.optional(),
    forcedInduction: forcedInduction.optional(),
    description: description.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "O'zgartirish uchun maydon berilmadi" });

export const injectionIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export type ListInjectionQuery = z.infer<typeof listInjectionQuerySchema>;
export type CreateInjectionInput = z.infer<typeof createInjectionSchema>;
export type UpdateInjectionInput = z.infer<typeof updateInjectionSchema>;
