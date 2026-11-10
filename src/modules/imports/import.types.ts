import { BatchStatus, FileBatchStatus, SourcePlatform, JobStatus, ExecutionCheckpoint } from '../../repositories/types.js';

export { SourcePlatform, BatchStatus, FileBatchStatus, JobStatus, ExecutionCheckpoint };

export type ImportLifecycleStatus =
  | 'UPLOAD_RECEIVED'
  | 'STAGING'
  | 'STAGING_COMPLETED'
  | 'QUEUED'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED';

export interface SourceFileDto {
  id: string;
  fileName: string;
  fileFingerprint: string;
  fileSizeBytes: string;
  totalPhysicalLines: number;
  fileStatus: FileBatchStatus;
  processedLines: number;
}

export interface ImportJobDto {
  id: string;
  status: JobStatus;
  checkpoint: ExecutionCheckpoint;
  attempts: number;
  maxAttempts: number;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  lastError: string | null;
}

export interface ImportBatchResponseDto {
  id: string;
  organizationId: string;
  batchNumber: string;
  gstRegistrationId: string | null;
  sourcePlatform: SourcePlatform;
  status: BatchStatus;
  lifecycleStatus: ImportLifecycleStatus;
  executionMode: string;
  totalRecordsProcessed: number;
  startedAt: string;
  completedAt: string | null;
  sourceFiles: SourceFileDto[];
}

export interface ImportStatusResponseDto {
  batchId: string;
  organizationId: string;
  status: BatchStatus;
  lifecycleStatus: ImportLifecycleStatus;
  stagingStatus: FileBatchStatus | 'UNKNOWN';
  job: ImportJobDto | null;
  totalRecordsProcessed: number;
  startedAt: string;
  completedAt: string | null;
}

export interface ImportMetricsDto {
  durationMs: number;
  recordsPerSecond: number;
  totalRecordsIngested: number;
  validOutcomes: number;
  warningOutcomes: number;
  reviewOutcomes: number;
  errorOutcomes: number;
  zeroDataLossVerified: boolean;
  aggregateTaxableTurnover: string;
  aggregateTaxCollected: string;
  aggregateTaxReversed: string;
  totalCreditNotes: number;
  matchedFull: number;
  matchedPartial: number;
  unmatchedOrphan: number;
}

export interface ImportSummaryResponseDto {
  batchId: string;
  organizationId: string;
  status: BatchStatus;
  lifecycleStatus: ImportLifecycleStatus;
  metrics: ImportMetricsDto | null;
  persistedCounts: {
    invoices: number;
    creditNotes: number;
    stockTransfers: number;
    reconciliations: number;
    validationIssues: number;
  };
}

export interface ListImportsQuery {
  page?: number;
  limit?: number;
  status?: BatchStatus;
  gstRegistrationId?: string;
  sourcePlatform?: SourcePlatform;
  from?: string;
  to?: string;
  sortBy?: 'startedAt' | 'completedAt' | 'batchNumber';
  sortOrder?: 'asc' | 'desc';
}

export interface PaginatedImportsDto {
  items: ImportBatchResponseDto[];
  pagination: {
    page: number;
    limit: number;
    totalItems: number;
    totalPages: number;
  };
}

export interface CreateImportServiceInput {
  gstRegistrationId: string;
  sourcePlatform: SourcePlatform;
  originalFileName: string;
  tempFilePath: string;
  fileSizeBytes: bigint;
  fingerprint: string;
  metadata?: Record<string, unknown>;
}
