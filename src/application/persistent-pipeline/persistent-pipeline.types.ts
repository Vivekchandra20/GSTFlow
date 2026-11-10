import {
  TenantContext,
  ImportBatchEntity,
  IImportBatchRepository,
  ISourceRecordRepository,
  ICanonicalDocumentRepository,
  IProcessingResultRepository,
  IReconciliationRepository,
  ITransactionManager,
  FileBatchStatus,
  ExecutionCheckpoint
} from '../../repositories/types.js';
import { ProcessingReport } from '../../pipeline/processing-report.js';
import { PipelineOrchestrator } from '../../pipeline/pipeline-orchestrator.js';

export interface ProcessingPersistenceResult {
  invoicesPersisted: number;
  invoiceLinesPersisted: number;
  creditNotesPersisted: number;
  stockTransfersPersisted: number;
  canonicalInvoicesCreated: number;
  canonicalCreditNotesCreated: number;
  canonicalTransfersCreated: number;
  conflictsDetected: number;
  reconciliationsCreated: number;
  reconciliationsSuperseded: number;
  cumulativeReversalsApplied: number;
  durationMs: number;
}

export interface RunPersistentBatchInput {
  /** Optional user-specified batch identifier. Auto-generated if omitted. */
  batchNumber?: string;
  /** Processing engine version tag (e.g. '0.1.0') */
  engineVersion: string;
  /** GST statutory rules version tag (e.g. '2024.1') */
  rulesVersion: string;
  /** Array of CSV file paths to ingest and process */
  filePaths: string[];
  /** Execution mode: 'STANDARD' for initial processing, 'REPROCESSING' for statutory/audit re-runs */
  executionMode?: 'STANDARD' | 'REPROCESSING';
  /** Reason for execution if executionMode is REPROCESSING */
  reprocessReason?: string | null;
  /** Reference to parent batch if this is a reprocessing execution */
  parentBatchId?: string | null;
  /** Execution configuration parameters */
  configuration?: Record<string, unknown>;
  /** Whether the input files should be processed using Amazon MTR live interleaved adapter */
  isLiveBatch?: boolean;
  /** Optional pre-registered source file IDs associated with this batch */
  sourceFileIds?: string[];
  /** Whether to stage source records into PostgreSQL during batch execution */
  stageSourceRecords?: boolean;
  /** Target chunk size for bulk staging inserts (default: 2,500) */
  stagingChunkSize?: number;
  /** Whether to persist canonical documents and execution processing results (defaults to true if repositories provided) */
  persistProcessingResults?: boolean;
  /** Whether to persist credit note reconciliation applications (defaults to true if repository provided) */
  persistReconciliations?: boolean;
  /** Target chunk size for processing result persistence (default: 500) */
  persistenceChunkSize?: number;
  /** Optional callback to notify durable execution checkpoint transitions */
  onCheckpoint?: (checkpoint: ExecutionCheckpoint) => Promise<void>;
}

export interface PersistentBatchResult {
  /** The final persisted ImportBatch entity */
  batch: ImportBatchEntity;
  /** The full processing report from the domain pipeline */
  report: ProcessingReport;
  /** Whether the batch completed successfully */
  success: boolean;
  /** Total wall-clock execution time in milliseconds */
  executionTimeMs: number;
  /** Optional staging results if staging was performed */
  stagingResult?: PersistentStagingResult;
  /** Optional persistence results if results were persisted */
  persistenceResult?: ProcessingPersistenceResult;
}

export interface ProcessStagedBatchInput {
  /** The UUID of the staged ImportBatch to process */
  importBatchId: string;
  /** Optional source file paths. If not specified, resolved from staged batch file associations */
  filePaths?: string[];
  /** Optional background processing job ID if invoked by an asynchronous worker */
  processingJobId?: string;
  /** Whether the input files should be processed using Amazon MTR live interleaved adapter */
  isLiveBatch?: boolean;
  /** Whether to persist canonical documents and execution processing results (default: true) */
  persistProcessingResults?: boolean;
  /** Whether to persist credit note reconciliation applications (default: true) */
  persistReconciliations?: boolean;
  /** Target chunk size for processing result persistence (default: 500) */
  persistenceChunkSize?: number;
  /** Optional callback to notify durable execution checkpoint transitions */
  onCheckpoint?: (checkpoint: ExecutionCheckpoint) => Promise<void>;
}

export interface StageBatchInput {
  /** Optional existing batch ID to stage files into */
  batchId?: string;
  /** Optional user-specified batch identifier if creating a new batch */
  batchNumber?: string;
  /** Processing engine version tag (e.g. '0.1.0') */
  engineVersion: string;
  /** GST statutory rules version tag (e.g. '2024.1') */
  rulesVersion: string;
  /** Array of CSV file paths to stage */
  filePaths: string[];
  /** Execution mode: 'STANDARD' or 'REPROCESSING' */
  executionMode?: 'STANDARD' | 'REPROCESSING';
  /** Reason for execution if executionMode is REPROCESSING */
  reprocessReason?: string | null;
  /** Reference to parent batch if this is a reprocessing execution */
  parentBatchId?: string | null;
  /** Execution configuration parameters */
  configuration?: Record<string, unknown>;
  /** Target chunk size for bulk database inserts (default: 2,500; clamped between 100 and 10,000) */
  chunkSize?: number;
  /** Optional base directory to enforce path traversal boundary */
  allowedUploadDir?: string;
}

export interface SourceFileStagingTiming {
  hashingMs: number;
  parsingMs: number;
  insertionMs: number;
  totalMs: number;
}

export interface SourceFileStagingResult {
  sourceFileId: string;
  fileName: string;
  fileFingerprint: string;
  fileSizeBytes: bigint;
  isDuplicate: boolean;
  reusedExisting: boolean;
  fileStatus: FileBatchStatus;
  totalPhysicalLines: number;
  headerLines: number;
  parsedLogicalRecords: number;
  recordsInserted: number;
  recordsSkipped: number;
  recordsRejected: number;
  totalDataRecords: number;
  durationMs: number;
  timings: SourceFileStagingTiming;
  error?: string;
}

export interface PersistentStagingResult {
  batch: ImportBatchEntity;
  success: boolean;
  filesStaged: SourceFileStagingResult[];
  totalRecordsInserted: number;
  totalRecordsSkipped: number;
  totalPhysicalLines: number;
  totalLogicalRecords: number;
  executionTimeMs: number;
}

export interface PersistentPipelineOrchestratorOptions {
  /** Repository for managing versioned batch lifecycles */
  importBatchRepo: IImportBatchRepository;
  /** Optional repository for staging immutable source files and records */
  sourceRecordRepo?: ISourceRecordRepository;
  /** Optional repository for canonical financial master documents */
  canonicalDocRepo?: ICanonicalDocumentRepository;
  /** Optional repository for batch-scoped execution processing results */
  processingResultRepo?: IProcessingResultRepository;
  /** Optional repository for credit note invoice reconciliations */
  reconciliationRepo?: IReconciliationRepository;
  /** Optional domain pipeline orchestrator instance (defaults to defaultOrchestrator) */
  pipelineOrchestrator?: PipelineOrchestrator;
  /** Optional transaction manager for coordinating transactional steps */
  transactionManager?: ITransactionManager;
  /** Default chunk size for bulk staging (defaults to 2,500) */
  stagingChunkSize?: number;
  /** Default chunk size for processing result persistence (defaults to 500) */
  persistenceChunkSize?: number;
  /** Optional base directory boundary for file path security */
  allowedUploadDir?: string;
  /** Optional base directory for content-addressed immutable file evidence storage */
  storageBaseDir?: string;
}
