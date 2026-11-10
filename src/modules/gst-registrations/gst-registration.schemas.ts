import { z } from 'zod';

export const GstRegistrationStatusSchema = z.enum([
  'ACTIVE',
  'CANCELLED',
  'SUSPENDED',
  'INACTIVE'
]);

export const GstRegistrationTypeSchema = z.enum([
  'REGULAR',
  'COMPOSITION',
  'ISD',
  'CASUAL',
  'NON_RESIDENT',
  'TCS_ECO',
  'TDS',
  'OIDAR'
]);

export const CreateGstRegistrationBodySchema = z.object({
  gstin: z
    .string()
    .trim()
    .min(15, 'GSTIN must be 15 characters')
    .max(15, 'GSTIN must be 15 characters'),
  legalName: z
    .string()
    .trim()
    .min(1, 'Legal name cannot be empty')
    .max(255, 'Legal name cannot exceed 255 characters'),
  tradeName: z
    .string()
    .trim()
    .max(255, 'Trade name cannot exceed 255 characters')
    .optional()
    .nullable(),
  registrationType: GstRegistrationTypeSchema.optional().default('REGULAR'),
  effectiveDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Effective date must be in YYYY-MM-DD format')
    .optional()
    .nullable()
});

export type CreateGstRegistrationBody = z.infer<typeof CreateGstRegistrationBodySchema>;

export const UpdateGstRegistrationBodySchema = z
  .object({
    legalName: z
      .string()
      .trim()
      .min(1, 'Legal name cannot be empty')
      .max(255, 'Legal name cannot exceed 255 characters')
      .optional(),
    tradeName: z
      .string()
      .trim()
      .max(255, 'Trade name cannot exceed 255 characters')
      .optional()
      .nullable(),
    registrationType: GstRegistrationTypeSchema.optional(),
    effectiveDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Effective date must be in YYYY-MM-DD format')
      .optional()
      .nullable()
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided for update'
  });

export type UpdateGstRegistrationBody = z.infer<typeof UpdateGstRegistrationBodySchema>;

export const UpdateGstRegistrationStatusBodySchema = z.object({
  status: GstRegistrationStatusSchema,
  cancellationDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Cancellation date must be in YYYY-MM-DD format')
    .optional()
    .nullable(),
  reason: z.string().trim().max(500, 'Reason cannot exceed 500 characters').optional()
});

export type UpdateGstRegistrationStatusBody = z.infer<
  typeof UpdateGstRegistrationStatusBodySchema
>;

export const ListGstRegistrationsQuerySchema = z.object({
  status: GstRegistrationStatusSchema.optional(),
  stateCode: z.string().regex(/^[0-9]{2}$/, 'State code must be a 2-digit number').optional(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

export type ListGstRegistrationsQuery = z.infer<typeof ListGstRegistrationsQuerySchema>;

export const GstRegistrationParamsSchema = z.object({
  organizationId: z.string().uuid('Invalid organization ID'),
  gstRegistrationId: z.string().uuid('Invalid GST registration ID').optional()
});

export type GstRegistrationParams = z.infer<typeof GstRegistrationParamsSchema>;
