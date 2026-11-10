import { z } from 'zod';

export const HealthResponseSchema = z.object({
  success: z.literal(true),
  status: z.literal('alive'),
  timestamp: z.string().datetime()
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const DependencyStatusSchema = z.enum(['connected', 'unavailable']);

export const ReadinessResponseSchema = z.object({
  success: z.boolean(),
  status: z.enum(['ready', 'not_ready']),
  dependencies: z.object({
    database: DependencyStatusSchema,
    redis: DependencyStatusSchema
  }),
  timestamp: z.string().datetime()
});

export type ReadinessResponse = z.infer<typeof ReadinessResponseSchema>;

export const ApiErrorItemSchema = z.object({
  field: z.string().optional(),
  message: z.string()
});

export const ApiErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.union([z.array(ApiErrorItemSchema), z.array(z.record(z.any())), z.array(z.string())]).optional()
  }),
  requestId: z.string()
});

export const UuidParamSchema = z.object({
  id: z.string().uuid()
});
