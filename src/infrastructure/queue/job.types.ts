export enum OutboxStatus {
  PENDING = 'PENDING',
  CLAIMED = 'CLAIMED',
  PUBLISHED = 'PUBLISHED',
  FAILED = 'FAILED'
}

export enum JobStatus {
  QUEUED = 'QUEUED',
  PROCESSING = 'PROCESSING',
  RETRYING = 'RETRYING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED'
}

export enum ExecutionCheckpoint {
  STAGING = 'STAGING',
  DOMAIN_PROCESSING = 'DOMAIN_PROCESSING',
  CANONICAL_PERSISTENCE = 'CANONICAL_PERSISTENCE',
  CREDIT_NOTE_RECONCILIATION = 'CREDIT_NOTE_RECONCILIATION',
  COMPLETED = 'COMPLETED'
}

export enum BatchExecutionMode {
  INGESTION = 'INGESTION',
  REPROCESSING = 'REPROCESSING'
}

export interface BatchProcessingJobPayload {
  processingJobId: string;
  organizationId: string;
  importBatchId: string;
  filePaths: string[];
  executionMode?: 'STANDARD' | 'REPROCESSING';
  isLiveBatch?: boolean;
  persistenceChunkSize?: number;
  configuration?: Record<string, unknown>;
}

export interface BatchProcessingJobResult {
  processingJobId: string;
  importBatchId: string;
  organizationId: string;
  checkpoint: ExecutionCheckpoint;
  invoiceCount: number;
  creditNoteCount: number;
  reconciliationCount: number;
  durationMs: number;
}
