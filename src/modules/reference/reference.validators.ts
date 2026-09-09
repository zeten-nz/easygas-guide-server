import { z } from 'zod';

const name = z.string().trim().min(1, 'Nomi kiritilishi shart').max(150);
const code = z.string().trim().min(1).max(30);

export const listReferenceQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(150).optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
});

export const createReferenceSchema = z.object({
  name,
  code: code.optional(), // required only for units — enforced in the service
});

export const updateReferenceSchema = z
  .object({
    name: name.optional(),
    code: code.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "O'zgartirish uchun maydon berilmadi" });

export const referenceIdParamsSchema = z.object({
  kind: z.string(),
  id: z.coerce.number().int().positive(),
});

export const referenceKindParamsSchema = z.object({
  kind: z.string(),
});

export type ListReferenceQueryInput = z.infer<typeof listReferenceQuerySchema>;
export type CreateReferenceInput = z.infer<typeof createReferenceSchema>;
export type UpdateReferenceInput = z.infer<typeof updateReferenceSchema>;
