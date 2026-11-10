import {
  TenantContext,
  IImportBatchRepository,
  ISourceRecordRepository,
  ICanonicalDocumentRepository,
  IProcessingResultRepository,
  IReconciliationRepository,
  ITransactionManager,
  BatchStatus,
  ImportBatchEntity,
  FileBatchStatus,
  CanonicalCreditNoteAlreadyReconciledError
} from '../../repositories/types.js';
import { PipelineOrchestrator, defaultOrchestrator } from '../../pipeline/pipeline-orchestrator.js';
import { ProcessingReport } from '../../pipeline/processing-report.js';
import { DetailedProcessingResult } from '../../pipeline/detailed-processing-result.js';
import { logger } from '../../utils/logger.js';
import {
  RunPersistentBatchInput,
  ProcessStagedBatchInput,
  PersistentBatchResult,
  StageBatchInput,
  PersistentStagingResult,
  SourceFileStagingResult,
  ProcessingPersistenceResult,
  PersistentPipelineOrchestratorOptions
} from './persistent-pipeline.types.js';
import {
  PersistentPipelineError,
  TenantContextInvalidError,
  InvalidBatchInputError,
  BatchLifecycleError,
  DomainPipelineExecutionError,
  PersistenceExecutionError,
  StagingExecutionError,
  BatchNotReadyForProcessingError
} from './persistent-pipeline.errors.js';
import { SourceStagingService } from './source-staging.service.js';
import { ProcessingPersistenceService, SourceFileInfo } from './processing-persistence.service.js';
import path from 'node:path';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * PersistentPipelineOrchestrator coordinates the lifecycle of persistent GST reconciliation batches.
 *
 * Architecture Boundary:
 * - Coordinates PostgreSQL persistence repositories (batch lifecycle, staging, audit trails).
 * - Delegates domain computations (normalization, deduplication, routing, reconciliation, validation)
 *   to the synchronous in-memory PipelineOrchestrator.
 * - Guarantees that GST calculations remain pure and free from database I/O.
 */
export class PersistentPipelineOrchestrator {
  private readonly importBatchRepo: IImportBatchRepository;
  private readonly sourceRecordRepo?: ISourceRecordRepository;
  private readonly canonicalDocRepo?: ICanonicalDocumentRepository;
  private readonly processingResultRepo?: IProcessingResultRepository;
  private readonly reconciliationRepo?: IReconciliationRepository;
  private readonly pipelineOrchestrator: PipelineOrchestrator;
  private readonly transactionManager?: ITransactionManager;
  private readonly stagingService?: SourceStagingService;
  private readonly persistenceService?: ProcessingPersistenceService;

  constructor(options: PersistentPipelineOrchestratorOptions) {
    if (!options || !options.importBatchRepo) {
      throw new Error('PersistentPipelineOrchestrator requires an importBatchRepo dependency.');
    }
    this.importBatchRepo = options.importBatchRepo;
    this.sourceRecordRepo = options.sourceRecordRepo;
    this.canonicalDocRepo = options.canonicalDocRepo;
    this.processingResultRepo = options.processingResultRepo;
    this.reconciliationRepo = options.reconciliationRepo;
    this.pipelineOrchestrator = options.pipelineOrchestrator || defaultOrchestrator;
    this.transactionManager = options.transactionManager;

    if (this.sourceRecordRepo) {
      this.stagingService = new SourceStagingService({
        sourceRecordRepo: this.sourceRecordRepo,
        batchRepo: this.importBatchRepo,
        defaultChunkSize: options.stagingChunkSize,
        allowedUploadDir: options.allowedUploadDir,
        storageBaseDir: options.storageBaseDir
      });
    }

    if (this.canonicalDocRepo && this.processingResultRepo) {
      this.persistenceService = new ProcessingPersistenceService({
        canonicalDocRepo: this.canonicalDocRepo,
        processingResultRepo: this.processingResultRepo,
        reconciliationRepo: this.reconciliationRepo,
        transactionManager: this.transactionManager,
        defaultChunkSize: options.persistenceChunkSize || 500
      });
    }
  }

  /**
   * Returns the underlying domain pipeline orchestrator instance.
   */
  public getPipelineOrchestrator(): PipelineOrchestrator {
    return this.pipelineOrchestrator;
  }

  /**
   * Returns the underlying import batch repository instance.
   */
  public getImportBatchRepository(): IImportBatchRepository {
    return this.importBatchRepo;
  }

  /**
   * Returns the underlying source record repository instance if configured.
   */
  public getSourceRecordRepository(): ISourceRecordRepository | undefined {
    return this.sourceRecordRepo;
  }

  /**
   * Returns the underlying canonical document repository instance if configured.
   */
  public getCanonicalDocumentRepository(): ICanonicalDocumentRepository | undefined {
    return this.canonicalDocRepo;
  }

  /**
   * Returns the underlying processing result repository instance if configured.
   */
  public getProcessingResultRepository(): IProcessingResultRepository | undefined {
    return this.processingResultRepo;
  }

  /**
   * Returns the underlying reconciliation repository instance if configured.
   */
  public getReconciliationRepository(): IReconciliationRepository | undefined {
    return this.reconciliationRepo;
  }

  /**
   * Returns the underlying processing persistence service if configured.
   */
  public getProcessingPersistenceService(): ProcessingPersistenceService | undefined {
    return this.persistenceService;
  }

  /**
   * Returns the underlying source staging service instance if configured.
   */
  public getSourceStagingService(): SourceStagingService | undefined {
    return this.stagingService;
  }

  /**
   * Returns the transaction manager instance if configured.
   */
  public getTransactionManager(): ITransactionManager | undefined {
    return this.transactionManager;
  }

  /**
   * Validates that the tenant context has a valid, authenticated UUID organization ID.
   */
  private validateTenant(ctx: TenantContext): void {
    if (!ctx || !ctx.organizationId || typeof ctx.organizationId !== 'string') {
      throw new TenantContextInvalidError('Tenant context is missing or organizationId is invalid.', {
        organizationId: ctx?.organizationId
      });
    }
    if (!UUID_REGEX.test(ctx.organizationId)) {
      throw new TenantContextInvalidError(
        `Tenant organization ID '${ctx.organizationId}' is not a valid UUID.`,
        { organizationId: ctx.organizationId }
      );
    }
  }

  /**
   * Validates that batch execution parameters are complete and well-formed.
   */
  private validateInput(ctx: TenantContext, input: RunPersistentBatchInput): void {
    if (!input) {
      throw new InvalidBatchInputError('Batch execution input is required.', {
        organizationId: ctx.organizationId
      });
    }
    if (!input.engineVersion || typeof input.engineVersion !== 'string' || input.engineVersion.trim() === '') {
      throw new InvalidBatchInputError('engineVersion must be a non-empty string.', {
        organizationId: ctx.organizationId
      });
    }
    if (!input.rulesVersion || typeof input.rulesVersion !== 'string' || input.rulesVersion.trim() === '') {
      throw new InvalidBatchInputError('rulesVersion must be a non-empty string.', {
        organizationId: ctx.organizationId
      });
    }
    if (!Array.isArray(input.filePaths) || input.filePaths.length === 0) {
      throw new InvalidBatchInputError('filePaths must be a non-empty array of file path strings.', {
        organizationId: ctx.organizationId
      });
    }
    for (const p of input.filePaths) {
      if (!p || typeof p !== 'string' || p.trim() === '') {
        throw new InvalidBatchInputError('filePaths contains an invalid or empty file path string.', {
          organizationId: ctx.organizationId
        });
      }
    }
  }

  /**
   * Executes a persistent reconciliation batch:
   * 1. Validates tenant identity and input parameters.
   * 2. Registers a new ImportBatch entity in PENDING state.
   * 3. Transitions status to PROCESSING.
   * 4. Executes the in-memory domain pipeline (synchronous calculation engine).
   * 5. Transitions status to COMPLETED with execution telemetry.
   * 6. On failure: Transitions status to FAILED and re-throws structured application error.
   */
  public async runBatch(
    ctx: TenantContext,
    input: RunPersistentBatchInput
  ): Promise<PersistentBatchResult> {
    const startTime = Date.now();

    // 1. Validate Tenant Context
    this.validateTenant(ctx);

    // 2. Validate Input Parameters
    this.validateInput(ctx, input);

    let batchId: string | undefined;
    let currentStatus: BatchStatus = BatchStatus.PENDING;

    try {
      let batch: ImportBatchEntity;
      let existingBatch: ImportBatchEntity | null = null;
      if (input.batchNumber) {
        existingBatch = await this.importBatchRepo.getBatchByNumber(ctx, input.batchNumber);
        if (existingBatch && (existingBatch.status === BatchStatus.COMPLETED || existingBatch.status === BatchStatus.FAILED)) {
          throw new BatchLifecycleError(
            `Cannot execute batch '${input.batchNumber}' with terminal status '${existingBatch.status}'.`,
            { organizationId: ctx.organizationId, batchId: existingBatch.id }
          );
        }
      }

      // 3. Resolve existing batch or initialize new ImportBatch (PENDING)
      if (existingBatch) {
        batch = existingBatch;
        batchId = batch.id;
        currentStatus = batch.status;
      } else {
        const batchNumber =
          input.batchNumber ||
          `BATCH-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

        batch = await this.importBatchRepo.createBatch(ctx, {
          batchNumber,
          engineVersion: input.engineVersion,
          rulesVersion: input.rulesVersion,
          executionMode: input.executionMode || 'STANDARD',
          reprocessReason: input.reprocessReason || null,
          parentBatchId: input.parentBatchId || null,
          configuration: input.configuration,
          sourceFileIds: input.sourceFileIds
        });
        batchId = batch.id;
        currentStatus = BatchStatus.PENDING;

        logger.info({
          event: 'BATCH_INITIALIZED',
          batchId,
          batchNumber: batch.batchNumber,
          organizationId: ctx.organizationId,
          executionMode: batch.executionMode,
          engineVersion: batch.engineVersion,
          rulesVersion: batch.rulesVersion
        }, 'Import batch registered in PENDING state.');
      }

      // 4. Transition to PROCESSING if not already in PROCESSING
      if (currentStatus === BatchStatus.PENDING) {
        await this.importBatchRepo.updateBatchStatus(
          ctx,
          batchId,
          BatchStatus.PENDING,
          BatchStatus.PROCESSING
        );
        currentStatus = BatchStatus.PROCESSING;

        logger.info({
          event: 'BATCH_PROCESSING_STARTED',
          batchId,
          organizationId: ctx.organizationId
        }, 'Import batch transitioned to PROCESSING state.');
      }

      // 5. Execute Pure Domain Pipeline (Synchronous/In-Memory Calculation)
      let stagingResult: PersistentStagingResult | undefined;
      const sourceFileMap = new Map<string, SourceFileInfo>();

      if (input.stageSourceRecords && this.stagingService) {
        stagingResult = await this.stageBatchInternal(ctx, batchId, {
          filePaths: input.filePaths,
          chunkSize: input.stagingChunkSize
        });

        // Ensure incomplete source files cannot enter domain processing
        for (const fileStaged of stagingResult.filesStaged) {
          if (fileStaged.fileStatus !== FileBatchStatus.COMPLETED) {
            throw new StagingExecutionError(
              `Source file '${fileStaged.fileName}' is incomplete or failed (status: ${fileStaged.fileStatus}). Incomplete source files cannot enter domain processing.`,
              { organizationId: ctx.organizationId, batchId, sourceFileId: fileStaged.sourceFileId }
            );
          }
        }
      }

      // Build source record lineage line map if sourceRecordRepo is available
      if (this.sourceRecordRepo) {
        if (stagingResult) {
          for (const fileStaged of stagingResult.filesStaged) {
            const lineMap = await this.sourceRecordRepo.findRecordLineMap(ctx, fileStaged.sourceFileId);
            const info: SourceFileInfo = { sourceFileId: fileStaged.sourceFileId, lineMap };
            sourceFileMap.set(fileStaged.fileName, info);
            sourceFileMap.set(path.basename(fileStaged.fileName), info);
            sourceFileMap.set(path.resolve(fileStaged.fileName), info);
          }
        } else {
          const batchWithFiles = await this.importBatchRepo.getBatchById(ctx, batchId);
          if (batchWithFiles?.fileAssociations) {
            for (const assoc of batchWithFiles.fileAssociations) {
              if (assoc.fileStatus !== FileBatchStatus.COMPLETED) {
                throw new StagingExecutionError(
                  `Batch source file '${assoc.sourceFile?.fileName || assoc.sourceFileId}' is not completed (status: ${assoc.fileStatus}). Cannot execute domain processing.`,
                  { organizationId: ctx.organizationId, batchId }
                );
              }
              const lineMap = await this.sourceRecordRepo.findRecordLineMap(ctx, assoc.sourceFileId);
              const info: SourceFileInfo = { sourceFileId: assoc.sourceFileId, lineMap };
              if (assoc.sourceFile) {
                sourceFileMap.set(assoc.sourceFile.fileName, info);
                sourceFileMap.set(path.basename(assoc.sourceFile.fileName), info);
              }
            }
          }
        }
      }

      let detailed: DetailedProcessingResult;
      try {
        if (input.isLiveBatch) {
          if (
            this.pipelineOrchestrator.processLiveBatch !== PipelineOrchestrator.prototype.processLiveBatch &&
            this.pipelineOrchestrator.processLiveBatchDetailed === PipelineOrchestrator.prototype.processLiveBatchDetailed
          ) {
            const report = await this.pipelineOrchestrator.processLiveBatch(input.filePaths);
            detailed = {
              report,
              invoices: new Map(),
              creditNotes: [],
              stockTransfers: [],
              cancelledOrders: [],
              malformedRecords: []
            };
          } else {
            detailed = await this.pipelineOrchestrator.processLiveBatchDetailed(input.filePaths);
          }
        } else {
          if (
            this.pipelineOrchestrator.processBatch !== PipelineOrchestrator.prototype.processBatch &&
            this.pipelineOrchestrator.processBatchDetailed === PipelineOrchestrator.prototype.processBatchDetailed
          ) {
            const report = await this.pipelineOrchestrator.processBatch(input.filePaths);
            detailed = {
              report,
              invoices: new Map(),
              creditNotes: [],
              stockTransfers: [],
              cancelledOrders: [],
              malformedRecords: []
            };
          } else {
            detailed = await this.pipelineOrchestrator.processBatchDetailed(input.filePaths);
          }
        }
      } catch (domainErr) {
        throw new DomainPipelineExecutionError(
          `Domain calculation pipeline failed during batch execution: ${
            domainErr instanceof Error ? domainErr.message : String(domainErr)
          }`,
          {
            cause: domainErr,
            organizationId: ctx.organizationId,
            batchId
          }
        );
      }

      const report = detailed.report;

      // 6. Persist Processing Results if repositories are configured
      let persistenceResult: ProcessingPersistenceResult | undefined;
      const shouldPersist = input.persistProcessingResults ?? (this.persistenceService !== undefined);

      if (shouldPersist && this.persistenceService) {
        persistenceResult = await this.persistenceService.persistBatchResults(
          ctx,
          batch,
          detailed,
          sourceFileMap,
          { chunkSize: input.persistenceChunkSize || 500 }
        );
      }

      // 7. Complete Batch
      const completedBatch = await this.importBatchRepo.updateBatchStatus(
        ctx,
        batchId,
        BatchStatus.PROCESSING,
        BatchStatus.COMPLETED,
        {
          completedAt: new Date(),
          totalRecordsProcessed: report.totalRecordsIngested
        }
      );
      currentStatus = BatchStatus.COMPLETED;

      const executionTimeMs = Date.now() - startTime;

      logger.info({
        event: 'BATCH_COMPLETED',
        batchId,
        organizationId: ctx.organizationId,
        totalRecords: report.totalRecordsIngested,
        durationMs: executionTimeMs,
        persistedInvoices: persistenceResult?.invoicesPersisted,
        persistedCreditNotes: persistenceResult?.creditNotesPersisted,
        persistedStockTransfers: persistenceResult?.stockTransfersPersisted,
        persistedReconciliations: persistenceResult?.reconciliationsCreated,
        supersededReconciliations: persistenceResult?.reconciliationsSuperseded,
        reversalsApplied: persistenceResult?.cumulativeReversalsApplied
      }, 'Import batch successfully completed.');

      return {
        batch: completedBatch,
        report,
        success: true,
        executionTimeMs,
        stagingResult,
        persistenceResult
      };
    } catch (error: any) {
      // 7. Robust Failure Transition: Ensure batch is marked FAILED if initialized
      if (batchId && currentStatus !== BatchStatus.COMPLETED) {
        try {
          await this.importBatchRepo.updateBatchStatus(
            ctx,
            batchId,
            currentStatus,
            BatchStatus.FAILED,
            { completedAt: new Date() }
          );

          logger.error({
            event: 'BATCH_FAILED',
            batchId,
            organizationId: ctx.organizationId,
            failedFromStatus: currentStatus,
            errorMessage: error instanceof Error ? error.message : String(error)
          }, 'Import batch transitioned to FAILED status.');
        } catch (failTransitionErr) {
          logger.error({
            event: 'BATCH_FAIL_TRANSITION_ERROR',
            batchId,
            organizationId: ctx.organizationId,
            originalError: error instanceof Error ? error.message : String(error),
            transitionError:
              failTransitionErr instanceof Error ? failTransitionErr.message : String(failTransitionErr)
          }, 'Failed to record FAILED status transition in database.');
        }
      }

      // Propagate structured application errors without swallowing
      if (
        error instanceof PersistentPipelineError ||
        error instanceof CanonicalCreditNoteAlreadyReconciledError
      ) {
        throw error;
      }

      throw new PersistenceExecutionError(
        `Persistent batch execution encountered an unexpected persistence error: ${
          error instanceof Error ? error.message : String(error)
        }`,
        {
          cause: error,
          organizationId: ctx.organizationId,
          batchId
        }
      );
    }
  }

  /**
   * Executes pure domain calculation and persistent storage for an already-staged batch.
   *
   * Invariants:
   * 1. Requires that ALL associated BatchSourceFiles are COMPLETED.
   * 2. Rejects batches with PENDING, PROCESSING, or FAILED source files.
   * 3. Executes pure domain normalization & calculations in-memory without DB I/O.
   * 4. Persists canonical documents, processing results, and credit note reconciliations in chunked transactions.
   * 5. Atomically marks the batch COMPLETED.
   */
  public async processStagedBatch(
    ctx: TenantContext,
    input: ProcessStagedBatchInput
  ): Promise<PersistentBatchResult> {
    const startTime = Date.now();
    this.validateTenant(ctx);

    if (!input || !input.importBatchId) {
      throw new InvalidBatchInputError('processStagedBatch requires a valid importBatchId.', {
        organizationId: ctx.organizationId
      });
    }

    const batchId = input.importBatchId;
    let currentStatus: BatchStatus = BatchStatus.PENDING;

    // 1. Fetch batch with its file associations
    const batchWithFiles = await this.importBatchRepo.getBatchById(ctx, batchId);
    if (!batchWithFiles) {
      throw new PersistenceExecutionError(`Import batch '${batchId}' not found.`, {
        organizationId: ctx.organizationId,
        batchId
      });
    }

    currentStatus = batchWithFiles.status;

    if (currentStatus === BatchStatus.COMPLETED || currentStatus === BatchStatus.FAILED) {
      throw new BatchLifecycleError(
        `Cannot execute batch '${batchId}' with terminal status '${currentStatus}'.`,
        { organizationId: ctx.organizationId, batchId }
      );
    }

    // 2. Preflight Readiness Verification: Verify all source files are COMPLETED
    const fileAssocs = batchWithFiles.fileAssociations || [];
    if (fileAssocs.length === 0 && (!input.filePaths || input.filePaths.length === 0)) {
      throw new BatchNotReadyForProcessingError(
        `Batch '${batchId}' has no associated source files and no file paths were provided. Cannot execute processing.`,
        { organizationId: ctx.organizationId, batchId }
      );
    }

    for (const assoc of fileAssocs) {
      if (assoc.fileStatus !== FileBatchStatus.COMPLETED) {
        throw new BatchNotReadyForProcessingError(
          `Batch source file '${assoc.sourceFile?.fileName || assoc.sourceFileId}' is not completed (status: ${assoc.fileStatus}). Incomplete or failed staging cannot trigger domain processing.`,
          { organizationId: ctx.organizationId, batchId }
        );
      }
    }

    // 3. Transition to PROCESSING if currently PENDING
    if (currentStatus === BatchStatus.PENDING) {
      await this.importBatchRepo.updateBatchStatus(
        ctx,
        batchId,
        BatchStatus.PENDING,
        BatchStatus.PROCESSING
      );
      currentStatus = BatchStatus.PROCESSING;
      logger.info({
        event: 'BATCH_PROCESSING_STARTED',
        batchId,
        organizationId: ctx.organizationId
      }, 'Import batch transitioned to PROCESSING state.');
    }

    try {
      // 4. Resolve source record line maps
      const sourceFileMap = new Map<string, SourceFileInfo>();
      const resolvedFilePaths: string[] = [];

      if (input.filePaths && input.filePaths.length > 0) {
        resolvedFilePaths.push(...input.filePaths);
      }

      if (this.sourceRecordRepo && fileAssocs.length > 0) {
        for (const assoc of fileAssocs) {
          const lineMap = await this.sourceRecordRepo.findRecordLineMap(ctx, assoc.sourceFileId);
          const info: SourceFileInfo = { sourceFileId: assoc.sourceFileId, lineMap };
          if (assoc.sourceFile) {
            sourceFileMap.set(assoc.sourceFile.fileName, info);
            sourceFileMap.set(path.basename(assoc.sourceFile.fileName), info);
            if (assoc.sourceFile.storageUri) {
              sourceFileMap.set(assoc.sourceFile.storageUri, info);
              if (resolvedFilePaths.length === 0) {
                resolvedFilePaths.push(assoc.sourceFile.storageUri);
              }
            }
          }
        }
      }

      if (resolvedFilePaths.length === 0 && fileAssocs.length > 0) {
        for (const assoc of fileAssocs) {
          if (assoc.sourceFile?.storageUri) {
            resolvedFilePaths.push(assoc.sourceFile.storageUri);
          } else if (assoc.sourceFile?.fileName) {
            resolvedFilePaths.push(assoc.sourceFile.fileName);
          }
        }
      }

      // 5. Pure In-Memory Domain Pipeline Execution
      let detailed: DetailedProcessingResult;
      try {
        if (input.isLiveBatch) {
          if (
            this.pipelineOrchestrator.processLiveBatch !== PipelineOrchestrator.prototype.processLiveBatch &&
            this.pipelineOrchestrator.processLiveBatchDetailed === PipelineOrchestrator.prototype.processLiveBatchDetailed
          ) {
            const report = await this.pipelineOrchestrator.processLiveBatch(resolvedFilePaths);
            detailed = {
              report,
              invoices: new Map(),
              creditNotes: [],
              stockTransfers: [],
              cancelledOrders: [],
              malformedRecords: []
            };
          } else {
            detailed = await this.pipelineOrchestrator.processLiveBatchDetailed(resolvedFilePaths);
          }
        } else {
          if (
            this.pipelineOrchestrator.processBatch !== PipelineOrchestrator.prototype.processBatch &&
            this.pipelineOrchestrator.processBatchDetailed === PipelineOrchestrator.prototype.processBatchDetailed
          ) {
            const report = await this.pipelineOrchestrator.processBatch(resolvedFilePaths);
            detailed = {
              report,
              invoices: new Map(),
              creditNotes: [],
              stockTransfers: [],
              cancelledOrders: [],
              malformedRecords: []
            };
          } else {
            detailed = await this.pipelineOrchestrator.processBatchDetailed(resolvedFilePaths);
          }
        }
      } catch (domainErr) {
        throw new DomainPipelineExecutionError(
          `Domain calculation pipeline failed during batch execution: ${
            domainErr instanceof Error ? domainErr.message : String(domainErr)
          }`,
          { cause: domainErr, organizationId: ctx.organizationId, batchId }
        );
      }

      const report = detailed.report;

      // 6. Persist Processing Results if repositories are configured
      let persistenceResult: ProcessingPersistenceResult | undefined;
      const shouldPersist = input.persistProcessingResults ?? (this.persistenceService !== undefined);

      if (shouldPersist && this.persistenceService) {
        persistenceResult = await this.persistenceService.persistBatchResults(
          ctx,
          batchWithFiles,
          detailed,
          sourceFileMap,
          {
            chunkSize: input.persistenceChunkSize || 500,
            onCheckpoint: input.onCheckpoint
          }
        );
      }

      // 7. Complete Batch
      const completedBatch = await this.importBatchRepo.updateBatchStatus(
        ctx,
        batchId,
        BatchStatus.PROCESSING,
        BatchStatus.COMPLETED,
        {
          completedAt: new Date(),
          totalRecordsProcessed: report.totalRecordsIngested
        }
      );
      currentStatus = BatchStatus.COMPLETED;

      const executionTimeMs = Date.now() - startTime;

      logger.info({
        event: 'BATCH_COMPLETED',
        batchId,
        organizationId: ctx.organizationId,
        totalRecords: report.totalRecordsIngested,
        durationMs: executionTimeMs,
        persistedInvoices: persistenceResult?.invoicesPersisted,
        persistedCreditNotes: persistenceResult?.creditNotesPersisted,
        persistedStockTransfers: persistenceResult?.stockTransfersPersisted,
        persistedReconciliations: persistenceResult?.reconciliationsCreated,
        supersededReconciliations: persistenceResult?.reconciliationsSuperseded,
        reversalsApplied: persistenceResult?.cumulativeReversalsApplied
      }, 'Import batch successfully completed.');

      return {
        batch: completedBatch,
        report,
        success: true,
        executionTimeMs,
        persistenceResult
      };
    } catch (error: any) {
      if (batchId && currentStatus !== BatchStatus.COMPLETED) {
        try {
          await this.importBatchRepo.updateBatchStatus(
            ctx,
            batchId,
            currentStatus,
            BatchStatus.FAILED,
            { completedAt: new Date() }
          );
        } catch (failTransitionErr) {
          logger.error({
            event: 'BATCH_FAIL_TRANSITION_ERROR',
            batchId,
            organizationId: ctx.organizationId,
            originalError: error instanceof Error ? error.message : String(error),
            transitionError:
              failTransitionErr instanceof Error ? failTransitionErr.message : String(failTransitionErr)
          }, 'Failed to record FAILED status transition in database.');
        }
      }

      if (
        error instanceof PersistentPipelineError ||
        error instanceof CanonicalCreditNoteAlreadyReconciledError
      ) {
        throw error;
      }

      throw new PersistenceExecutionError(
        `Persistent batch execution encountered an unexpected persistence error: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error, organizationId: ctx.organizationId, batchId }
      );
    }
  }

  /**
   * Stages raw marketplace source files into PostgreSQL without executing the domain pipeline.
   *
   * Flow:
   * 1. Validates tenant identity and file existence.
   * 2. Registers or resolves an ImportBatch in PROCESSING state.
   * 3. Computes SHA-256 fingerprints and handles duplicate file detection.
   * 4. Streams records and bulk-inserts them in bounded chunked transactions.
   * 5. Updates BatchSourceFile status (COMPLETED or FAILED) and tracks physical line counts.
   * 6. Leaves ImportBatch in PROCESSING state awaiting subsequent domain calculation.
   */
  public async stageBatch(
    ctx: TenantContext,
    input: StageBatchInput
  ): Promise<PersistentStagingResult> {
    const startTime = Date.now();
    this.validateTenant(ctx);

    if (!input || !Array.isArray(input.filePaths) || input.filePaths.length === 0) {
      throw new InvalidBatchInputError('stageBatch requires a non-empty filePaths array.', {
        organizationId: ctx.organizationId
      });
    }

    if (!this.stagingService) {
      throw new PersistenceExecutionError(
        'SourceRecordRepository is required to execute persistent source staging.',
        { organizationId: ctx.organizationId }
      );
    }

    let batchId = input.batchId;
    let batch: ImportBatchEntity;

    if (batchId) {
      const existing = await this.importBatchRepo.getBatchById(ctx, batchId);
      if (!existing) {
        throw new PersistenceExecutionError(`Import batch '${batchId}' not found.`, {
          organizationId: ctx.organizationId,
          batchId
        });
      }
      batch = existing;
      if (batch.status === BatchStatus.COMPLETED || batch.status === BatchStatus.FAILED) {
        throw new BatchLifecycleError(
          `Cannot stage files into batch '${batchId}' with terminal status '${batch.status}'.`,
          { organizationId: ctx.organizationId, batchId }
        );
      }
      if (batch.status === BatchStatus.PENDING) {
        batch = await this.importBatchRepo.updateBatchStatus(
          ctx,
          batchId,
          BatchStatus.PENDING,
          BatchStatus.PROCESSING
        );
      }
    } else {
      const batchNumber =
        input.batchNumber ||
        `BATCH-STAGE-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

      const created = await this.importBatchRepo.createBatch(ctx, {
        batchNumber,
        engineVersion: input.engineVersion || '0.1.0',
        rulesVersion: input.rulesVersion || '2024.1',
        executionMode: input.executionMode || 'STANDARD',
        reprocessReason: input.reprocessReason || null,
        parentBatchId: input.parentBatchId || null,
        configuration: input.configuration
      });
      batchId = created.id;

      batch = await this.importBatchRepo.updateBatchStatus(
        ctx,
        created.id,
        BatchStatus.PENDING,
        BatchStatus.PROCESSING
      );
    }

    const currentBatchId = batchId!;
    return await this.stageBatchInternal(ctx, currentBatchId, input, batch, startTime);
  }

  private async stageBatchInternal(
    ctx: TenantContext,
    batchId: string,
    input: { filePaths: string[]; chunkSize?: number; allowedUploadDir?: string },
    existingBatch?: ImportBatchEntity,
    startTime: number = Date.now()
  ): Promise<PersistentStagingResult> {
    const filesStaged: SourceFileStagingResult[] = [];
    let totalInserted = 0;
    let totalSkipped = 0;
    let totalPhysical = 0;
    let totalLogical = 0;

    try {
      for (const filePath of input.filePaths) {
        const fileResult = await this.stagingService!.stageFile(ctx, batchId, filePath, {
          chunkSize: input.chunkSize,
          allowedUploadDir: input.allowedUploadDir
        });
        filesStaged.push(fileResult);
        totalInserted += fileResult.recordsInserted;
        totalSkipped += fileResult.recordsSkipped;
        totalPhysical += fileResult.totalPhysicalLines;
        totalLogical += fileResult.parsedLogicalRecords;
      }

      const batch = existingBatch || (await this.importBatchRepo.getBatchById(ctx, batchId))!;

      return {
        batch,
        success: true,
        filesStaged,
        totalRecordsInserted: totalInserted,
        totalRecordsSkipped: totalSkipped,
        totalPhysicalLines: totalPhysical,
        totalLogicalRecords: totalLogical,
        executionTimeMs: Date.now() - startTime
      };
    } catch (err: any) {
      try {
        await this.importBatchRepo.updateBatchStatus(
          ctx,
          batchId,
          BatchStatus.PROCESSING,
          BatchStatus.FAILED,
          { completedAt: new Date() }
        );
      } catch (updateErr) {
        logger.error({
          event: 'BATCH_FAIL_UPDATE_ERROR',
          batchId,
          error: String(updateErr)
        }, 'Failed to update batch status to FAILED after staging error.');
      }

      if (err instanceof PersistentPipelineError) {
        throw err;
      }

      throw new StagingExecutionError(
        `Batch source staging failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err, organizationId: ctx.organizationId, batchId }
      );
    }
  }
}
