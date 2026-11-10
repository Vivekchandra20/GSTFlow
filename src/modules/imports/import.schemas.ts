import { z } from 'zod';
import { SourcePlatform, BatchStatus, FileBatchStatus, JobStatus, ExecutionCheckpoint } from '../../repositories/types.js';

export const sourcePlatformEnumSchema = z.enum(['AMAZON', 'FLIPKART', 'MEESHO', 'CUSTOM']);
export const batchStatusEnumSchema = z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED']);
export const fileBatchStatusEnumSchema = z.enum(['QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED']);
export const jobStatusEnumSchema = z.enum(['QUEUED', 'PROCESSING', 'RETRYING', 'COMPLETED', 'FAILED', 'CANCELLED']);
export const checkpointEnumSchema = z.enum(['STAGING', 'DOMAIN_PROCESSING', 'CANONICAL_PERSISTENCE', 'CREDIT_NOTE_RECONCILIATION', 'COMPLETED']);

export const orgParamSchema = z.object({
  organizationId: z.string().uuid({ message: 'organizationId must be a valid RFC 4122 UUID' })
});

export const importBatchParamSchema = z.object({
  organizationId: z.string().uuid({ message: 'organizationId must be a valid RFC 4122 UUID' }),
  batchId: z.string().uuid({ message: 'batchId must be a valid RFC 4122 UUID' })
});

export const uploadImportMultipartBodySchema = z.object({
  gstRegistrationId: z.string().uuid({ message: 'gstRegistrationId must be a valid UUID' }),
  sourcePlatform: sourcePlatformEnumSchema.default('AMAZON'),
  metadata: z.string().optional() // JSON-encoded string if sent via form-data
});

export const listImportsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: batchStatusEnumSchema.optional(),
  gstRegistrationId: z.string().uuid().optional(),
  sourcePlatform: sourcePlatformEnumSchema.optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  sortBy: z.enum(['startedAt', 'completedAt', 'batchNumber']).default('startedAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc')
});

export const sourceFileDtoSchema = z.object({
  id: z.string().uuid(),
  fileName: z.string(),
  fileFingerprint: z.string(),
  fileSizeBytes: z.string(),
  totalPhysicalLines: z.number().int(),
  fileStatus: fileBatchStatusEnumSchema,
  processedLines: z.number().int()
});

export const importBatchResponseDtoSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  batchNumber: z.string(),
  gstRegistrationId: z.string().uuid().nullable(),
  sourcePlatform: sourcePlatformEnumSchema,
  status: batchStatusEnumSchema,
  lifecycleStatus: z.string(),
  executionMode: z.string(),
  totalRecordsProcessed: z.number().int(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  sourceFiles: z.array(sourceFileDtoSchema)
});

export const importStatusResponseDtoSchema = z.object({
  batchId: z.string().uuid(),
  organizationId: z.string().uuid(),
  status: batchStatusEnumSchema,
  lifecycleStatus: z.string(),
  stagingStatus: z.string(),
  job: z.object({
    id: z.string().uuid(),
    status: jobStatusEnumSchema,
    checkpoint: checkpointEnumSchema,
    attempts: z.number().int(),
    maxAttempts: z.number().int(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    failedAt: z.string().nullable(),
    lastError: z.string().nullable()
  }).nullable(),
  totalRecordsProcessed: z.number().int(),
  startedAt: z.string(),
  completedAt: z.string().nullable()
});

export const importSummaryResponseDtoSchema = z.object({
  batchId: z.string().uuid(),
  organizationId: z.string().uuid(),
  status: batchStatusEnumSchema,
  lifecycleStatus: z.string(),
  metrics: z.object({
    durationMs: z.number().int(),
    recordsPerSecond: z.number().int(),
    totalRecordsIngested: z.number().int(),
    validOutcomes: z.number().int(),
    warningOutcomes: z.number().int(),
    reviewOutcomes: z.number().int(),
    errorOutcomes: z.number().int(),
    zeroDataLossVerified: z.boolean(),
    aggregateTaxableTurnover: z.string(),
    aggregateTaxCollected: z.string(),
    aggregateTaxReversed: z.string(),
    totalCreditNotes: z.number().int(),
    matchedFull: z.number().int(),
    matchedPartial: z.number().int(),
    unmatchedOrphan: z.number().int()
  }).nullable(),
  persistedCounts: z.object({
    invoices: z.number().int(),
    creditNotes: z.number().int(),
    stockTransfers: z.number().int(),
    reconciliations: z.number().int(),
    validationIssues: z.number().int()
  })
});

export const paginatedImportsResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    items: z.array(importBatchResponseDtoSchema),
    pagination: z.object({
      page: z.number().int(),
      limit: z.number().int(),
      totalItems: z.number().int(),
      totalPages: z.number().int()
    })
  }),
  requestId: z.string()
});
