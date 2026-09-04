import { z } from 'zod';

const decimalSchema = z
  .number()
  .finite()
  .min(-999_999_999)
  .max(999_999_999);

export const measurementDefSchema = z
  .object({
    name: z.string().trim().min(2, "O'lchov nomi kamida 2 ta belgi").max(150),
    unit: z.string().trim().min(1, "O'lchov birligi kiritilishi shart").max(30),
    minValue: decimalSchema.nullable().optional(),
    maxValue: decimalSchema.nullable().optional(),
    expectedValue: decimalSchema.nullable().optional(),
    required: z.boolean().optional().default(true),
  })
  .refine(
    (m) => m.minValue == null || m.maxValue == null || m.minValue <= m.maxValue,
    { message: "Minimal qiymat maksimaldan katta bo'lishi mumkin emas" },
  );

export const createTemplateSchema = z.object({
  name: z.string().trim().min(3, 'Shablon nomi kamida 3 ta belgi').max(150),
  description: z.string().trim().max(500).nullable().optional(),
});

export const stepSchema = z.object({
  name: z.string().trim().min(3, 'Bosqich nomi kamida 3 ta belgi').max(200),
  description: z.string().trim().max(1000).nullable().optional(),
  requirements: z.string().trim().max(1000).nullable().optional(),
  isStop: z.boolean().optional().default(false),
  riskWeight: z.number().int().min(0).max(100).optional().default(0),
  requiredPhotos: z.number().int().min(0).max(20).optional().default(0),
  measurements: z.array(measurementDefSchema).max(20).optional().default([]),
});

export const moveStepSchema = z.object({
  direction: z.enum(['up', 'down']),
});

export const templateIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const versionParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  versionId: z.coerce.number().int().positive(),
});

export const stepParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  versionId: z.coerce.number().int().positive(),
  stepId: z.coerce.number().int().positive(),
});

export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;
export type StepInput = z.infer<typeof stepSchema>;
export type MeasurementDefInput = z.infer<typeof measurementDefSchema>;
