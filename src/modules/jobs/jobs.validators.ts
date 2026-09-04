import { z } from 'zod';

/** Full status set per loyiha.md §12. Phase 4 transitions cover only a subset. */
export const JOB_STATUSES = [
  'DRAFT',
  'IN_PROGRESS',
  'WAITING_STOP_APPROVAL',
  'REJECTED',
  'QUALITY_REVIEW',
  'COMPLETED',
  'REOPENED',
  'CANCELLED',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const listJobsQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  status: z.enum(JOB_STATUSES).optional(),
  branchId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const jobIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

/**
 * Job creation carries ONLY the relationship ids. The branch always comes
 * from the authenticated user (never from the client) and status is always
 * DRAFT — a stray branchId/status in the body is stripped by Zod.
 */
export const createJobSchema = z.object({
  customerId: z.number().int().positive('Mijoz tanlanishi shart'),
  vehicleId: z.number().int().positive('Avtomobil tanlanishi shart'),
});

export const cancelJobSchema = z.object({
  reason: z.string().trim().min(3, "Bekor qilish sababi ko'rsatilishi shart").max(500),
});

/** Installation details per loyiha.md §13 — exact fields, nothing invented. */
export const GAS_TYPES = ['LPG', 'CNG'] as const;

export const installationSchema = z
  .object({
    gasType: z.enum(GAS_TYPES).nullable().optional(),
    kit: z.string().trim().max(100).nullable().optional(),
    ecu: z.string().trim().max(100).nullable().optional(),
    cylinder: z.string().trim().max(100).nullable().optional(),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "O'zgartirish uchun maydon berilmadi" });

export type InstallationInput = z.infer<typeof installationSchema>;

export type ListJobsQuery = z.infer<typeof listJobsQuerySchema>;
export type CreateJobInput = z.infer<typeof createJobSchema>;
