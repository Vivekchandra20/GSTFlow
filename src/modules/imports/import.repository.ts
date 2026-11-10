import crypto from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  TenantContext,
  TransactionClient,
  CreateImportBatchInput,
  ImportBatchEntity,
  ImportBatchWithFiles,
  ProcessingJobEntity,
  OutboxEventEntity,
  JobStatus,
  ExecutionCheckpoint,
  BatchStatus,
  FileBatchStatus,
  SourcePlatform,
  OutboxStatus,
  BatchExecutionMode
} from '../../repositories/types.js';
import { runInTenantTransaction } from '../../repositories/prisma/tenant-context.js';
import {
  ListImportsQuery,
  ImportSummaryResponseDto,
  ImportLifecycleStatus
} from './import.types.js';

export interface IImportRepository {
  createImportBatch(
    ctx: TenantContext,
    input: CreateImportBatchInput,
    tx?: TransactionClient
  ): Promise<ImportBatchEntity>;

  getImportById(
    ctx: TenantContext,
    batchId: string,
    tx?: TransactionClient
  ): Promise<ImportBatchWithFiles | null>;

  listImports(
    ctx: TenantContext,
    query: ListImportsQuery,
    tx?: TransactionClient
  ): Promise<{ items: ImportBatchWithFiles[]; total: number }>;

  getLatestJobForBatch(
    ctx: TenantContext,
    batchId: string,
    tx?: TransactionClient
  ): Promise<ProcessingJobEntity | null>;

  getImportSummary(
    ctx: TenantContext,
    batchId: string,
    tx?: TransactionClient
  ): Promise<ImportSummaryResponseDto | null>;

  createJobAndOutbox(
    ctx: TenantContext,
    input: {
      processingJobId: string;
      batchId: string;
      filePaths: string[];
      configuration?: Record<string, unknown>;
    },
    tx?: TransactionClient
  ): Promise<{ job: ProcessingJobEntity; outbox: OutboxEventEntity }>;
}

export class PrismaImportRepository implements IImportRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public async createImportBatch(
    ctx: TenantContext,
    input: CreateImportBatchInput,
    tx?: TransactionClient
  ): Promise<ImportBatchEntity> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const batchId = input.id || crypto.randomUUID();

        const configData: Record<string, unknown> = { ...(input.configuration || {}) };
        if (input.gstRegistrationId) {
          configData.gstRegistrationId = input.gstRegistrationId;
        }
        if (input.sourcePlatform) {
          configData.sourcePlatform = input.sourcePlatform;
        }

        const created = await client.importBatch.create({
          data: {
            id: batchId,
            organizationId: ctx.organizationId,
            batchNumber: input.batchNumber,
            engineVersion: input.engineVersion,
            rulesVersion: input.rulesVersion,
            status: BatchStatus.PENDING,
            executionMode: input.executionMode || 'STANDARD',
            reprocessReason: input.reprocessReason || null,
            parentBatchId: input.parentBatchId || null,
            configuration: configData as Prisma.InputJsonValue
          }
        });

        return {
          id: created.id,
          organizationId: created.organizationId,
          batchNumber: created.batchNumber,
          engineVersion: created.engineVersion,
          rulesVersion: created.rulesVersion,
          status: created.status,
          executionMode: created.executionMode,
          reprocessReason: created.reprocessReason,
          parentBatchId: created.parentBatchId,
          startedAt: created.startedAt,
          completedAt: created.completedAt,
          totalRecordsProcessed: created.totalRecordsProcessed,
          configuration: created.configuration,
          gstRegistrationId: (created.configuration as any)?.gstRegistrationId || input.gstRegistrationId || null,
          sourcePlatform: (created.configuration as any)?.sourcePlatform || input.sourcePlatform || 'AMAZON'
        };
      },
      tx
    );
  }

  public async getImportById(
    ctx: TenantContext,
    batchId: string,
    tx?: TransactionClient
  ): Promise<ImportBatchWithFiles | null> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const batch = await client.importBatch.findFirst({
          where: { id: batchId, organizationId: ctx.organizationId },
          include: {
            fileAssociations: {
              include: { sourceFile: true }
            },
            parentBatch: true
          }
        });

        if (!batch) return null;

        return {
          id: batch.id,
          organizationId: batch.organizationId,
          batchNumber: batch.batchNumber,
          engineVersion: batch.engineVersion,
          rulesVersion: batch.rulesVersion,
          status: batch.status,
          executionMode: batch.executionMode,
          reprocessReason: batch.reprocessReason,
          parentBatchId: batch.parentBatchId,
          startedAt: batch.startedAt,
          completedAt: batch.completedAt,
          totalRecordsProcessed: batch.totalRecordsProcessed,
          configuration: batch.configuration,
          gstRegistrationId: (batch.configuration as any)?.gstRegistrationId || (batch as any).gstRegistrationId || null,
          sourcePlatform: (batch.configuration as any)?.sourcePlatform || (batch as any).sourcePlatform || 'AMAZON',
          fileAssociations: batch.fileAssociations.map((fa) => ({
            id: fa.id,
            organizationId: fa.organizationId,
            importBatchId: fa.importBatchId,
            sourceFileId: fa.sourceFileId,
            fileStatus: fa.fileStatus,
            processedLines: fa.processedLines,
            errorSummary: fa.errorSummary,
            sourceFile: {
              id: fa.sourceFile.id,
              organizationId: fa.sourceFile.organizationId,
              fileName: fa.sourceFile.fileName,
              fileFingerprint: fa.sourceFile.fileFingerprint,
              fileSizeBytes: fa.sourceFile.fileSizeBytes,
              storageUri: fa.sourceFile.storageUri,
              reportPeriod: fa.sourceFile.reportPeriod,
              sourceReportType: fa.sourceFile.sourceReportType,
              totalPhysicalLines: fa.sourceFile.totalPhysicalLines,
              uploadedAt: fa.sourceFile.uploadedAt
            }
          })),
          parentBatch: batch.parentBatch
            ? {
                id: batch.parentBatch.id,
                organizationId: batch.parentBatch.organizationId,
                batchNumber: batch.parentBatch.batchNumber,
                engineVersion: batch.parentBatch.engineVersion,
                rulesVersion: batch.parentBatch.rulesVersion,
                status: batch.parentBatch.status,
                executionMode: batch.parentBatch.executionMode,
                reprocessReason: batch.parentBatch.reprocessReason,
                parentBatchId: batch.parentBatch.parentBatchId,
                startedAt: batch.parentBatch.startedAt,
                completedAt: batch.parentBatch.completedAt,
                totalRecordsProcessed: batch.parentBatch.totalRecordsProcessed,
                configuration: batch.parentBatch.configuration,
                gstRegistrationId:
                  (batch.parentBatch.configuration as any)?.gstRegistrationId ||
                  (batch.parentBatch as any).gstRegistrationId ||
                  null,
                sourcePlatform:
                  (batch.parentBatch.configuration as any)?.sourcePlatform ||
                  (batch.parentBatch as any).sourcePlatform ||
                  'AMAZON'
              }
            : null
        };
      },
      tx
    );
  }

  public async listImports(
    ctx: TenantContext,
    query: ListImportsQuery,
    tx?: TransactionClient
  ): Promise<{ items: ImportBatchWithFiles[]; total: number }> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const page = query.page || 1;
        const limit = query.limit || 20;
        const skip = (page - 1) * limit;

        const where: Prisma.ImportBatchWhereInput = {
          organizationId: ctx.organizationId,
          ...(query.status ? { status: query.status } : {})
        };

        if (query.from || query.to) {
          where.startedAt = {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lte: new Date(query.to) } : {})
          };
        }

        const sortBy = query.sortBy || 'startedAt';
        const sortOrder = query.sortOrder || 'desc';

        const [total, batches] = await Promise.all([
          client.importBatch.count({ where }),
          client.importBatch.findMany({
            where,
            include: {
              fileAssociations: {
                include: { sourceFile: true }
              },
              parentBatch: true
            },
            orderBy: { [sortBy]: sortOrder },
            skip,
            take: limit
          })
        ]);

        let items: ImportBatchWithFiles[] = batches.map((batch) => ({
          id: batch.id,
          organizationId: batch.organizationId,
          batchNumber: batch.batchNumber,
          engineVersion: batch.engineVersion,
          rulesVersion: batch.rulesVersion,
          status: batch.status,
          executionMode: batch.executionMode,
          reprocessReason: batch.reprocessReason,
          parentBatchId: batch.parentBatchId,
          startedAt: batch.startedAt,
          completedAt: batch.completedAt,
          totalRecordsProcessed: batch.totalRecordsProcessed,
          configuration: batch.configuration,
          gstRegistrationId: (batch.configuration as any)?.gstRegistrationId || (batch as any).gstRegistrationId || null,
          sourcePlatform: (batch.configuration as any)?.sourcePlatform || (batch as any).sourcePlatform || 'AMAZON',
          fileAssociations: batch.fileAssociations.map((fa) => ({
            id: fa.id,
            organizationId: fa.organizationId,
            importBatchId: fa.importBatchId,
            sourceFileId: fa.sourceFileId,
            fileStatus: fa.fileStatus,
            processedLines: fa.processedLines,
            errorSummary: fa.errorSummary,
            sourceFile: {
              id: fa.sourceFile.id,
              organizationId: fa.sourceFile.organizationId,
              fileName: fa.sourceFile.fileName,
              fileFingerprint: fa.sourceFile.fileFingerprint,
              fileSizeBytes: fa.sourceFile.fileSizeBytes,
              storageUri: fa.sourceFile.storageUri,
              reportPeriod: fa.sourceFile.reportPeriod,
              sourceReportType: fa.sourceFile.sourceReportType,
              totalPhysicalLines: fa.sourceFile.totalPhysicalLines,
              uploadedAt: fa.sourceFile.uploadedAt
            }
          })),
          parentBatch: null
        }));

        if (query.gstRegistrationId) {
          items = items.filter((b) => b.gstRegistrationId === query.gstRegistrationId);
        }
        if (query.sourcePlatform) {
          items = items.filter((b) => b.sourcePlatform === query.sourcePlatform);
        }

        return { items, total: items.length };
      },
      tx
    );
  }

  public async getLatestJobForBatch(
    ctx: TenantContext,
    batchId: string,
    tx?: TransactionClient
  ): Promise<ProcessingJobEntity | null> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const job = await client.processingJob.findFirst({
          where: {
            organizationId: ctx.organizationId,
            importBatchId: batchId
          },
          orderBy: { createdAt: 'desc' }
        });

        if (!job) return null;

        return {
          id: job.id,
          organizationId: job.organizationId,
          importBatchId: job.importBatchId,
          jobType: job.jobType,
          status: job.status as JobStatus,
          executionCheckpoint: job.executionCheckpoint as ExecutionCheckpoint,
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
          bullmqJobId: job.bullmqJobId,
          executionMode: job.executionMode as BatchExecutionMode,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
          failedAt: job.failedAt,
          lastError: job.lastError,
          errorStack: job.errorStack,
          metadata: job.metadata,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt
        };
      },
      tx
    );
  }

  public async getImportSummary(
    ctx: TenantContext,
    batchId: string,
    tx?: TransactionClient
  ): Promise<ImportSummaryResponseDto | null> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const batch = await client.importBatch.findFirst({
          where: { id: batchId, organizationId: ctx.organizationId },
          include: { metrics: true }
        });

        if (!batch) return null;

        const [invoices, creditNotes, stockTransfers, reconciliations, validationIssues] = await Promise.all([
          client.invoiceProcessingResult.count({
            where: { organizationId: ctx.organizationId, importBatchId: batchId }
          }),
          client.creditNoteProcessingResult.count({
            where: { organizationId: ctx.organizationId, importBatchId: batchId }
          }),
          client.stockTransferProcessingResult.count({
            where: { organizationId: ctx.organizationId, importBatchId: batchId }
          }),
          client.reconciliation.count({
            where: { organizationId: ctx.organizationId, importBatchId: batchId }
          }),
          client.validationIssue.count({
            where: { organizationId: ctx.organizationId, importBatchId: batchId }
          })
        ]);

        const m = batch.metrics;
        const metricsDto = m
          ? {
              durationMs: m.durationMs,
              recordsPerSecond: m.recordsPerSecond,
              totalRecordsIngested: m.totalRecordsIngested,
              validOutcomes: m.validOutcomes,
              warningOutcomes: m.warningOutcomes,
              reviewOutcomes: m.reviewOutcomes,
              errorOutcomes: m.errorOutcomes,
              zeroDataLossVerified: m.zeroDataLossVerified,
              aggregateTaxableTurnover: m.aggregateTaxableTurnover.toFixed(2),
              aggregateTaxCollected: m.aggregateTaxCollected.toFixed(2),
              aggregateTaxReversed: m.aggregateTaxReversed.toFixed(2),
              totalCreditNotes: m.totalCreditNotes,
              matchedFull: m.matchedFull,
              matchedPartial: m.matchedPartial,
              unmatchedOrphan: m.unmatchedOrphan
            }
          : null;

        const lifecycleStatus: ImportLifecycleStatus =
          batch.status === BatchStatus.COMPLETED
            ? 'COMPLETED'
            : batch.status === BatchStatus.FAILED
              ? 'FAILED'
              : 'PROCESSING';

        return {
          batchId: batch.id,
          organizationId: batch.organizationId,
          status: batch.status,
          lifecycleStatus,
          metrics: metricsDto,
          persistedCounts: {
            invoices,
            creditNotes,
            stockTransfers,
            reconciliations,
            validationIssues
          }
        };
      },
      tx
    );
  }

  public async createJobAndOutbox(
    ctx: TenantContext,
    input: {
      processingJobId: string;
      batchId: string;
      filePaths: string[];
      configuration?: Record<string, unknown>;
    },
    tx?: TransactionClient
  ): Promise<{ job: ProcessingJobEntity; outbox: OutboxEventEntity }> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const job = await client.processingJob.create({
          data: {
            id: input.processingJobId,
            organizationId: ctx.organizationId,
            importBatchId: input.batchId,
            jobType: 'BATCH_PROCESSING',
            status: JobStatus.QUEUED,
            executionCheckpoint: ExecutionCheckpoint.DOMAIN_PROCESSING,
            executionMode: BatchExecutionMode.INGESTION,
            metadata: (input.configuration || {}) as Prisma.InputJsonValue
          }
        });

        const outbox = await client.outboxEvent.create({
          data: {
            organizationId: ctx.organizationId,
            eventType: 'BATCH_PROCESSING',
            status: OutboxStatus.PENDING,
            payload: {
              processingJobId: input.processingJobId,
              organizationId: ctx.organizationId,
              importBatchId: input.batchId,
              filePaths: input.filePaths,
              executionMode: 'STANDARD',
              configuration: input.configuration || {}
            } as Prisma.InputJsonValue
          }
        });

        return {
          job: {
            id: job.id,
            organizationId: job.organizationId,
            importBatchId: job.importBatchId,
            jobType: job.jobType,
            status: job.status as JobStatus,
            executionCheckpoint: job.executionCheckpoint as ExecutionCheckpoint,
            attempts: job.attempts,
            maxAttempts: job.maxAttempts,
            bullmqJobId: job.bullmqJobId,
            executionMode: job.executionMode as BatchExecutionMode,
            startedAt: job.startedAt,
            completedAt: job.completedAt,
            failedAt: job.failedAt,
            lastError: job.lastError,
            errorStack: job.errorStack,
            metadata: job.metadata,
            createdAt: job.createdAt,
            updatedAt: job.updatedAt
          },
          outbox: {
            id: outbox.id,
            organizationId: outbox.organizationId,
            eventType: outbox.eventType,
            payload: outbox.payload as Record<string, unknown>,
            status: outbox.status as OutboxStatus,
            claimedBy: outbox.claimedBy,
            leaseExpiresAt: outbox.leaseExpiresAt,
            publishedAt: outbox.publishedAt,
            attempts: outbox.attempts,
            lastError: outbox.lastError,
            createdAt: outbox.createdAt,
            updatedAt: outbox.updatedAt
          }
        };
      },
      tx
    );
  }
}
