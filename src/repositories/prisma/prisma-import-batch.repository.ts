import crypto from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  IImportBatchRepository,
  TenantContext,
  CreateImportBatchInput,
  ImportBatchEntity,
  ImportBatchWithFiles,
  BatchSourceFileEntity,
  CreateReprocessingBatchInput,
  UpdateBatchStatusMetadata,
  BatchStatus,
  FileBatchStatus,
  BatchNotFoundError,
  SourceFileNotFoundError,
  IllegalBatchStatusTransitionError,
  DuplicateBatchAssociationError
} from '../types.js';
import { runInTenantTransaction } from './tenant-context.js';

const PERMITTED_STATUS_TRANSITIONS: Record<BatchStatus, BatchStatus[]> = {
  [BatchStatus.PENDING]: [BatchStatus.PROCESSING, BatchStatus.FAILED],
  [BatchStatus.PROCESSING]: [BatchStatus.COMPLETED, BatchStatus.FAILED],
  [BatchStatus.COMPLETED]: [], // Immutable finalized statutory state
  [BatchStatus.FAILED]: [] // Terminal failure state; reprocessing requires a new batch
};

export class PrismaImportBatchRepository implements IImportBatchRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public async createBatch(
    ctx: TenantContext,
    input: CreateImportBatchInput,
    tx?: Prisma.TransactionClient
  ): Promise<ImportBatchEntity> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const batchId = input.id || crypto.randomUUID();

        // 1. Verify parent batch if specified
        if (input.parentBatchId) {
          const parent = await client.importBatch.findFirst({
            where: { id: input.parentBatchId, organizationId: ctx.organizationId }
          });
          if (!parent) {
            throw new BatchNotFoundError(input.parentBatchId, ctx.organizationId);
          }
        }

        // 2. Verify source files if specified upfront
        if (input.sourceFileIds && input.sourceFileIds.length > 0) {
          const files = await client.sourceFile.findMany({
            where: {
              id: { in: input.sourceFileIds },
              organizationId: ctx.organizationId
            }
          });
          if (files.length !== input.sourceFileIds.length) {
            const foundIds = new Set(files.map((f) => f.id));
            const missingId = input.sourceFileIds.find((id) => !foundIds.has(id));
            throw new SourceFileNotFoundError(missingId!, ctx.organizationId);
          }
        }

        const configData: Record<string, unknown> = { ...(input.configuration || {}) };
        if (input.gstRegistrationId) {
          configData.gstRegistrationId = input.gstRegistrationId;
        }
        if (input.sourcePlatform) {
          configData.sourcePlatform = input.sourcePlatform;
        }

        // 3. Create the import batch
        const batch = await client.importBatch.create({
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

        // 4. Associate initial source files if provided
        if (input.sourceFileIds && input.sourceFileIds.length > 0) {
          const fileAssocs: Prisma.BatchSourceFileCreateManyInput[] = input.sourceFileIds.map(
            (sfId) => ({
              id: crypto.randomUUID(),
              organizationId: ctx.organizationId,
              importBatchId: batchId,
              sourceFileId: sfId,
              fileStatus: FileBatchStatus.QUEUED,
              processedLines: 0
            })
          );
          await client.batchSourceFile.createMany({ data: fileAssocs });
        }

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
          configuration: batch.configuration
        };
      },
      tx
    );
  }

  public async getBatchById(
    ctx: TenantContext,
    batchId: string,
    tx?: Prisma.TransactionClient
  ): Promise<ImportBatchWithFiles | null> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const batch = await client.importBatch.findFirst({
          where: {
            id: batchId,
            organizationId: ctx.organizationId
          },
          include: {
            fileAssociations: {
              include: {
                sourceFile: true
              }
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
                configuration: batch.parentBatch.configuration
              }
            : null,
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
          }))
        };
      },
      tx
    );
  }

  public async getBatchByNumber(
    ctx: TenantContext,
    batchNumber: string,
    tx?: Prisma.TransactionClient
  ): Promise<ImportBatchEntity | null> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const batch = await client.importBatch.findFirst({
          where: {
            batchNumber,
            organizationId: ctx.organizationId
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
          configuration: batch.configuration
        };
      },
      tx
    );
  }

  public async updateBatchStatus(
    ctx: TenantContext,
    batchId: string,
    currentStatus: BatchStatus,
    newStatus: BatchStatus,
    metadata?: UpdateBatchStatusMetadata,
    tx?: Prisma.TransactionClient
  ): Promise<ImportBatchEntity> {
    const permitted = PERMITTED_STATUS_TRANSITIONS[currentStatus];
    if (!permitted || !permitted.includes(newStatus)) {
      throw new IllegalBatchStatusTransitionError(batchId, currentStatus, newStatus);
    }

    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const batch = await client.importBatch.findFirst({
          where: {
            id: batchId,
            organizationId: ctx.organizationId
          }
        });

        if (!batch) {
          throw new BatchNotFoundError(batchId, ctx.organizationId);
        }

        if (batch.status !== currentStatus) {
          throw new IllegalBatchStatusTransitionError(
            batchId,
            batch.status,
            newStatus,
            `Batch '${batchId}' current status is ${batch.status}; expected ${currentStatus} for transition to ${newStatus}.`
          );
        }

        const isTerminal =
          newStatus === BatchStatus.COMPLETED || newStatus === BatchStatus.FAILED;

        const updated = await client.importBatch.update({
          where: { id: batchId },
          data: {
            status: newStatus,
            completedAt: isTerminal
              ? metadata?.completedAt || new Date()
              : batch.completedAt,
            totalRecordsProcessed:
              metadata?.totalRecordsProcessed !== undefined
                ? metadata.totalRecordsProcessed
                : batch.totalRecordsProcessed
          }
        });

        return {
          id: updated.id,
          organizationId: updated.organizationId,
          batchNumber: updated.batchNumber,
          engineVersion: updated.engineVersion,
          rulesVersion: updated.rulesVersion,
          status: updated.status,
          executionMode: updated.executionMode,
          reprocessReason: updated.reprocessReason,
          parentBatchId: updated.parentBatchId,
          startedAt: updated.startedAt,
          completedAt: updated.completedAt,
          totalRecordsProcessed: updated.totalRecordsProcessed,
          configuration: updated.configuration
        };
      },
      tx
    );
  }

  public async associateSourceFile(
    ctx: TenantContext,
    batchId: string,
    sourceFileId: string,
    initialStatus: FileBatchStatus = FileBatchStatus.QUEUED,
    tx?: Prisma.TransactionClient
  ): Promise<BatchSourceFileEntity> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const batch = await client.importBatch.findFirst({
          where: { id: batchId, organizationId: ctx.organizationId }
        });
        if (!batch) {
          throw new BatchNotFoundError(batchId, ctx.organizationId);
        }
        if (batch.status === BatchStatus.COMPLETED) {
          throw new IllegalBatchStatusTransitionError(
            batchId,
            batch.status,
            batch.status,
            `Cannot associate source files with completed batch '${batchId}'.`
          );
        }

        const sourceFile = await client.sourceFile.findFirst({
          where: { id: sourceFileId, organizationId: ctx.organizationId }
        });
        if (!sourceFile) {
          throw new SourceFileNotFoundError(sourceFileId, ctx.organizationId);
        }

        const existing = await client.batchSourceFile.findUnique({
          where: {
            importBatchId_sourceFileId: {
              importBatchId: batchId,
              sourceFileId
            }
          }
        });
        if (existing) {
          throw new DuplicateBatchAssociationError(batchId, sourceFileId);
        }

        const assoc = await client.batchSourceFile.create({
          data: {
            id: crypto.randomUUID(),
            organizationId: ctx.organizationId,
            importBatchId: batchId,
            sourceFileId,
            fileStatus: initialStatus,
            processedLines: 0
          }
        });

        return {
          id: assoc.id,
          organizationId: assoc.organizationId,
          importBatchId: assoc.importBatchId,
          sourceFileId: assoc.sourceFileId,
          fileStatus: assoc.fileStatus,
          processedLines: assoc.processedLines,
          errorSummary: assoc.errorSummary
        };
      },
      tx
    );
  }

  public async updateBatchSourceFileStatus(
    ctx: TenantContext,
    batchId: string,
    sourceFileId: string,
    fileStatus: FileBatchStatus,
    processedLines?: number,
    errorSummary?: string | null,
    tx?: Prisma.TransactionClient
  ): Promise<BatchSourceFileEntity> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const assoc = await client.batchSourceFile.findUnique({
          where: {
            importBatchId_sourceFileId: {
              importBatchId: batchId,
              sourceFileId
            }
          }
        });
        if (!assoc || assoc.organizationId !== ctx.organizationId) {
          throw new BatchNotFoundError(
            `Association between batch '${batchId}' and source file '${sourceFileId}' not found`,
            ctx.organizationId
          );
        }

        const updated = await client.batchSourceFile.update({
          where: { id: assoc.id },
          data: {
            fileStatus,
            processedLines:
              processedLines !== undefined ? processedLines : assoc.processedLines,
            errorSummary:
              errorSummary !== undefined ? errorSummary : assoc.errorSummary
          }
        });

        return {
          id: updated.id,
          organizationId: updated.organizationId,
          importBatchId: updated.importBatchId,
          sourceFileId: updated.sourceFileId,
          fileStatus: updated.fileStatus,
          processedLines: updated.processedLines,
          errorSummary: updated.errorSummary
        };
      },
      tx
    );
  }

  public async createReprocessingBatch(
    ctx: TenantContext,
    input: CreateReprocessingBatchInput,
    tx?: Prisma.TransactionClient
  ): Promise<ImportBatchEntity> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        // 1. Fetch and verify parent batch
        const parent = await client.importBatch.findFirst({
          where: { id: input.parentBatchId, organizationId: ctx.organizationId }
        });
        if (!parent) {
          throw new BatchNotFoundError(input.parentBatchId, ctx.organizationId);
        }

        // 2. Verify all specified source files exist in this organization
        const files = await client.sourceFile.findMany({
          where: {
            id: { in: input.sourceFileIds },
            organizationId: ctx.organizationId
          }
        });
        if (files.length !== input.sourceFileIds.length) {
          const foundIds = new Set(files.map((f) => f.id));
          const missingId = input.sourceFileIds.find((id) => !foundIds.has(id));
          throw new SourceFileNotFoundError(missingId!, ctx.organizationId);
        }

        const newBatchId = crypto.randomUUID();

        // 3. Create the reprocessing batch with explicit linkage to parent
        const batch = await client.importBatch.create({
          data: {
            id: newBatchId,
            organizationId: ctx.organizationId,
            batchNumber: input.newBatchNumber,
            engineVersion: input.engineVersion || parent.engineVersion,
            rulesVersion: input.rulesVersion || parent.rulesVersion,
            status: BatchStatus.PENDING,
            executionMode: 'REPROCESSING',
            reprocessReason: input.reprocessReason,
            parentBatchId: parent.id,
            configuration: (input.configuration || parent.configuration || {}) as Prisma.InputJsonValue
          }
        });

        // 4. Associate the existing immutable source files with the new batch
        const fileAssocs: Prisma.BatchSourceFileCreateManyInput[] = input.sourceFileIds.map(
          (sfId) => ({
            id: crypto.randomUUID(),
            organizationId: ctx.organizationId,
            importBatchId: newBatchId,
            sourceFileId: sfId,
            fileStatus: FileBatchStatus.QUEUED,
            processedLines: 0
          })
        );
        await client.batchSourceFile.createMany({ data: fileAssocs });

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
          configuration: batch.configuration
        };
      },
      tx
    );
  }

  public async listBatches(
    ctx: TenantContext,
    options?: {
      status?: BatchStatus;
      executionMode?: string;
      limit?: number;
      offset?: number;
    },
    tx?: Prisma.TransactionClient
  ): Promise<ImportBatchEntity[]> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const batches = await client.importBatch.findMany({
          where: {
            organizationId: ctx.organizationId,
            ...(options?.status ? { status: options.status } : {}),
            ...(options?.executionMode ? { executionMode: options.executionMode } : {})
          },
          orderBy: { startedAt: 'desc' },
          take: options?.limit,
          skip: options?.offset
        });

        return batches.map((b) => ({
          id: b.id,
          organizationId: b.organizationId,
          batchNumber: b.batchNumber,
          engineVersion: b.engineVersion,
          rulesVersion: b.rulesVersion,
          status: b.status,
          executionMode: b.executionMode,
          reprocessReason: b.reprocessReason,
          parentBatchId: b.parentBatchId,
          startedAt: b.startedAt,
          completedAt: b.completedAt,
          totalRecordsProcessed: b.totalRecordsProcessed,
          configuration: b.configuration
        }));
      },
      tx
    );
  }

  public async findBatchSourceFilesBySourceFile(
    ctx: TenantContext,
    sourceFileId: string,
    tx?: Prisma.TransactionClient
  ): Promise<BatchSourceFileEntity[]> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const rows = await client.batchSourceFile.findMany({
          where: {
            organizationId: ctx.organizationId,
            sourceFileId
          }
        });

        return rows.map((r) => ({
          id: r.id,
          organizationId: r.organizationId,
          importBatchId: r.importBatchId,
          sourceFileId: r.sourceFileId,
          fileStatus: r.fileStatus,
          processedLines: r.processedLines,
          errorSummary: r.errorSummary
        }));
      },
      tx
    );
  }
}
