import crypto from 'node:crypto';
import {
  TenantContext,
  ISourceRecordRepository,
  IImportBatchRepository,
  FileBatchStatus,
  BatchStatus
} from '../../repositories/types.js';
import { IGstRegistrationRepository } from '../gst-registrations/gst-registration.repository.js';
import { IImportRepository } from './import.repository.js';
import { SourceStagingService } from '../../application/persistent-pipeline/source-staging.service.js';
import { OutboxDispatcher } from '../../infrastructure/queue/outbox-dispatcher.js';
import {
  CreateImportServiceInput,
  ImportBatchResponseDto,
  ImportStatusResponseDto,
  ImportSummaryResponseDto,
  ListImportsQuery,
  PaginatedImportsDto,
  ImportLifecycleStatus
} from './import.types.js';
import {
  ImportNotFoundError,
  DuplicateImportError,
  GstRegistrationNotEligibleError,
  ImportProcessingError
} from './import.errors.js';
import { logger } from '../../utils/logger.js';

export interface ImportServiceOptions {
  importRepo: IImportRepository;
  gstRegistrationRepo: IGstRegistrationRepository;
  batchRepo?: IImportBatchRepository;
  sourceRecordRepo?: ISourceRecordRepository;
  stagingService?: SourceStagingService;
  outboxDispatcher?: OutboxDispatcher;
  engineVersion?: string;
  rulesVersion?: string;
}

export class ImportService {
  private readonly importRepo: IImportRepository;
  private readonly gstRegistrationRepo: IGstRegistrationRepository;
  private readonly batchRepo?: IImportBatchRepository;
  private readonly sourceRecordRepo?: ISourceRecordRepository;
  private readonly stagingService?: SourceStagingService;
  private readonly outboxDispatcher?: OutboxDispatcher;
  private readonly engineVersion: string;
  private readonly rulesVersion: string;

  constructor(options: ImportServiceOptions) {
    this.importRepo = options.importRepo;
    this.gstRegistrationRepo = options.gstRegistrationRepo;
    this.batchRepo = options.batchRepo;
    this.sourceRecordRepo = options.sourceRecordRepo;
    this.stagingService = options.stagingService;
    this.outboxDispatcher = options.outboxDispatcher;
    this.engineVersion = options.engineVersion || '0.1.0';
    this.rulesVersion = options.rulesVersion || '2024.1';
  }

  /**
   * Orchestrates the secure source file upload, registration verification,
   * duplicate check, staging, and transactional outbox job creation.
   */
  public async createImport(
    ctx: TenantContext,
    input: CreateImportServiceInput
  ): Promise<ImportBatchResponseDto> {
    // 1. Verify GST Registration Ownership and Operational Usability
    const gstReg = await this.gstRegistrationRepo.findById(ctx.organizationId, input.gstRegistrationId);
    if (!gstReg) {
      throw new GstRegistrationNotEligibleError(
        input.gstRegistrationId,
        'GST registration does not exist or does not belong to this organization.'
      );
    }

    if (gstReg.status === 'CANCELLED') {
      throw new GstRegistrationNotEligibleError(
        input.gstRegistrationId,
        'GST registration is CANCELLED. Statutory filing and imports are prohibited.',
        'CANCELLED'
      );
    }

    if (gstReg.status === 'SUSPENDED') {
      throw new GstRegistrationNotEligibleError(
        input.gstRegistrationId,
        'GST registration is SUSPENDED. Imports are temporarily blocked.',
        'SUSPENDED'
      );
    }

    if (gstReg.status === 'INACTIVE' || !gstReg.isActive) {
      throw new GstRegistrationNotEligibleError(
        input.gstRegistrationId,
        'GST registration is INACTIVE.',
        'INACTIVE'
      );
    }

    // 2. Organization-Scoped Duplicate File Detection
    if (this.sourceRecordRepo && this.batchRepo) {
      const existingFile = await this.sourceRecordRepo.findSourceFileByFingerprint(ctx, input.fingerprint);
      if (existingFile) {
        const associations = await this.batchRepo.findBatchSourceFilesBySourceFile(ctx, existingFile.id);

        // Check if any associated batch is currently processing or queued
        const activeAssoc = associations.find(
          (a) => a.fileStatus === FileBatchStatus.PROCESSING || a.fileStatus === FileBatchStatus.QUEUED
        );
        if (activeAssoc) {
          throw new DuplicateImportError(
            `A source file with identical SHA-256 fingerprint is currently being processed in batch '${activeAssoc.importBatchId}'.`,
            'DUPLICATE_IMPORT_IN_PROGRESS',
            {
              existingFileId: existingFile.id,
              batchId: activeAssoc.importBatchId,
              fingerprint: input.fingerprint
            }
          );
        }

        // Check if any associated batch was already completed
        const completedAssoc = associations.find((a) => a.fileStatus === FileBatchStatus.COMPLETED);
        if (completedAssoc) {
          const completedBatch = await this.importRepo.getImportById(ctx, completedAssoc.importBatchId);
          if (completedBatch && completedBatch.status === BatchStatus.COMPLETED) {
            throw new DuplicateImportError(
              `An identical source file has already been imported and completed in batch '${completedBatch.batchNumber}'. Duplicate financial processing prevented.`,
              'FILE_ALREADY_PROCESSED',
              {
                existingFileId: existingFile.id,
                batchId: completedBatch.id,
                batchNumber: completedBatch.batchNumber,
                fingerprint: input.fingerprint,
                completedAt: completedBatch.completedAt?.toISOString()
              }
            );
          }
        }
      }
    }

    // 3. Create Import Batch in PENDING state
    const batchNumber = `BATCH-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const batch = await this.importRepo.createImportBatch(ctx, {
      batchNumber,
      engineVersion: this.engineVersion,
      rulesVersion: this.rulesVersion,
      executionMode: 'STANDARD',
      gstRegistrationId: input.gstRegistrationId,
      sourcePlatform: input.sourcePlatform,
      configuration: {
        originalFileName: input.originalFileName,
        fileSizeBytes: input.fileSizeBytes.toString(),
        fingerprint: input.fingerprint,
        sourcePlatform: input.sourcePlatform,
        ...(input.metadata || {})
      }
    });

    let stagedFilePath = input.tempFilePath;

    // 4. Stage File into PostgreSQL (Streaming CSV Ingestion)
    if (this.stagingService) {
      try {
        const stagingResult = await this.stagingService.stageFile(ctx, batch.id, input.tempFilePath);
        logger.info(
          {
            event: 'IMPORT_FILE_STAGED',
            batchId: batch.id,
            sourceFileId: stagingResult.sourceFileId,
            recordsInserted: stagingResult.recordsInserted,
            durationMs: stagingResult.durationMs
          },
          'Source file staged successfully into database.'
        );
      } catch (stagingErr) {
        logger.error(
          {
            event: 'IMPORT_STAGING_FAILED',
            batchId: batch.id,
            err: stagingErr instanceof Error ? stagingErr.message : String(stagingErr)
          },
          'Failed to stage source file for import batch.'
        );
        throw new ImportProcessingError(
          `Failed to stage uploaded source file into database: ${
            stagingErr instanceof Error ? stagingErr.message : String(stagingErr)
          }`,
          stagingErr
        );
      }
    }

    // 5. Transactionally Create Background ProcessingJob and OutboxEvent
    const processingJobId = crypto.randomUUID();
    await this.importRepo.createJobAndOutbox(ctx, {
      processingJobId,
      batchId: batch.id,
      filePaths: [stagedFilePath],
      configuration: {
        originalFileName: input.originalFileName,
        gstRegistrationId: input.gstRegistrationId,
        sourcePlatform: input.sourcePlatform
      }
    });

    // 6. Non-blocking outbox dispatch attempt
    if (this.outboxDispatcher) {
      this.outboxDispatcher.dispatchOnce().catch((dispErr) => {
        logger.warn(
          { err: dispErr instanceof Error ? dispErr.message : String(dispErr) },
          'Immediate outbox dispatch attempt deferred to background polling cycle.'
        );
      });
    }

    // 7. Return detailed DTO
    const fullBatch = await this.importRepo.getImportById(ctx, batch.id);
    return this.mapToBatchResponseDto(fullBatch || { ...batch, fileAssociations: [] }, 'QUEUED');
  }

  /**
   * Lists imports with pagination and filtering.
   */
  public async listImports(
    ctx: TenantContext,
    query: ListImportsQuery
  ): Promise<PaginatedImportsDto> {
    const { items, total } = await this.importRepo.listImports(ctx, query);
    const limit = query.limit || 20;
    const page = query.page || 1;
    const totalPages = Math.ceil(total / limit) || 1;

    return {
      items: items.map((b) => this.mapToBatchResponseDto(b)),
      pagination: {
        page,
        limit,
        totalItems: total,
        totalPages
      }
    };
  }

  /**
   * Retrieves single import details.
   */
  public async getImport(ctx: TenantContext, batchId: string): Promise<ImportBatchResponseDto> {
    const batch = await this.importRepo.getImportById(ctx, batchId);
    if (!batch) {
      throw new ImportNotFoundError(batchId, ctx.organizationId);
    }
    return this.mapToBatchResponseDto(batch);
  }

  /**
   * Retrieves import and processing status with job checkpoints.
   */
  public async getImportStatus(
    ctx: TenantContext,
    batchId: string
  ): Promise<ImportStatusResponseDto> {
    const batch = await this.importRepo.getImportById(ctx, batchId);
    if (!batch) {
      throw new ImportNotFoundError(batchId, ctx.organizationId);
    }

    const job = await this.importRepo.getLatestJobForBatch(ctx, batchId);
    const firstAssoc = batch.fileAssociations?.[0];
    const stagingStatus = firstAssoc?.fileStatus || 'UNKNOWN';

    let lifecycleStatus: ImportLifecycleStatus = 'QUEUED';
    if (batch.status === BatchStatus.COMPLETED) {
      lifecycleStatus = 'COMPLETED';
    } else if (batch.status === BatchStatus.FAILED || job?.status === 'FAILED') {
      lifecycleStatus = 'FAILED';
    } else if (job?.status === 'PROCESSING') {
      lifecycleStatus = 'PROCESSING';
    } else if (stagingStatus === FileBatchStatus.PROCESSING) {
      lifecycleStatus = 'STAGING';
    } else if (stagingStatus === FileBatchStatus.COMPLETED && job?.status === 'QUEUED') {
      lifecycleStatus = 'STAGING_COMPLETED';
    }

    return {
      batchId: batch.id,
      organizationId: batch.organizationId,
      status: batch.status,
      lifecycleStatus,
      stagingStatus,
      job: job
        ? {
            id: job.id,
            status: job.status,
            checkpoint: job.executionCheckpoint,
            attempts: job.attempts,
            maxAttempts: job.maxAttempts,
            startedAt: job.startedAt?.toISOString() || null,
            completedAt: job.completedAt?.toISOString() || null,
            failedAt: job.failedAt?.toISOString() || null,
            lastError: job.lastError
          }
        : null,
      totalRecordsProcessed: batch.totalRecordsProcessed,
      startedAt: batch.startedAt.toISOString(),
      completedAt: batch.completedAt?.toISOString() || null
    };
  }

  /**
   * Retrieves aggregated processing results summary.
   */
  public async getImportSummary(
    ctx: TenantContext,
    batchId: string
  ): Promise<ImportSummaryResponseDto> {
    const summary = await this.importRepo.getImportSummary(ctx, batchId);
    if (!summary) {
      throw new ImportNotFoundError(batchId, ctx.organizationId);
    }
    return summary;
  }

  private mapToBatchResponseDto(
    b: any,
    overrideLifecycle?: ImportLifecycleStatus
  ): ImportBatchResponseDto {
    const lifecycleStatus: ImportLifecycleStatus =
      overrideLifecycle ||
      (b.status === BatchStatus.COMPLETED
        ? 'COMPLETED'
        : b.status === BatchStatus.FAILED
          ? 'FAILED'
          : b.status === BatchStatus.PROCESSING
            ? 'PROCESSING'
            : 'QUEUED');

    return {
      id: b.id,
      organizationId: b.organizationId,
      batchNumber: b.batchNumber,
      gstRegistrationId: b.gstRegistrationId || null,
      sourcePlatform: b.sourcePlatform || 'AMAZON',
      status: b.status,
      lifecycleStatus,
      executionMode: b.executionMode || 'STANDARD',
      totalRecordsProcessed: b.totalRecordsProcessed || 0,
      startedAt: b.startedAt instanceof Date ? b.startedAt.toISOString() : String(b.startedAt),
      completedAt: b.completedAt ? (b.completedAt instanceof Date ? b.completedAt.toISOString() : String(b.completedAt)) : null,
      sourceFiles: (b.fileAssociations || []).map((fa: any) => ({
        id: fa.sourceFile?.id || fa.sourceFileId,
        fileName: fa.sourceFile?.fileName || 'unknown',
        fileFingerprint: fa.sourceFile?.fileFingerprint || '',
        fileSizeBytes: fa.sourceFile?.fileSizeBytes ? fa.sourceFile.fileSizeBytes.toString() : '0',
        totalPhysicalLines: fa.sourceFile?.totalPhysicalLines || 0,
        fileStatus: fa.fileStatus,
        processedLines: fa.processedLines || 0
      }))
    };
  }
}
