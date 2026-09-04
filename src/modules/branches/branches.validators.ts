import { z } from 'zod';

const branchFields = {
  name: z.string().trim().min(3, "Filial nomi kamida 3 ta belgidan iborat bo'lishi kerak").max(150),
  region: z.string().trim().min(2, 'Viloyat tanlanishi shart').max(60),
  address: z.string().trim().max(255).nullable().optional(),
  phone: z
    .string()
    .trim()
    .regex(/^[+\d][\d\s\-()]{5,19}$/, "Telefon raqam noto'g'ri formatda")
    .nullable()
    .optional(),
};

export const createBranchSchema = z.object(branchFields);

export const updateBranchSchema = z
  .object({
    name: branchFields.name.optional(),
    region: branchFields.region.optional(),
    address: branchFields.address,
    phone: branchFields.phone,
  })
  .refine((v) => Object.keys(v).length > 0, { message: "O'zgartirish uchun maydon berilmadi" });

export const branchIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export type CreateBranchInput = z.infer<typeof createBranchSchema>;
export type UpdateBranchInput = z.infer<typeof updateBranchSchema>;
