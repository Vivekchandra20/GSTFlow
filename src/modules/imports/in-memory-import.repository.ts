import crypto from 'node:crypto';
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
  OutboxStatus,
  BatchExecutionMode
} from '../../repositories/types.js';
import { IImportRepository } from './import.repository.js';
import { ListImportsQuery, ImportSummaryResponseDto, ImportLifecycleStatus } from './import.types.js';

export class InMemoryImportRepository implements IImportRepository {
  private batches = new Map<string, ImportBatchWithFiles>();
  private jobs = new Map<string, ProcessingJobEntity>();
  private outboxEvents = new Map<string, OutboxEventEntity>();

  public reset(): void {
    this.batches.clear();
    this.jobs.clear();
    this.outboxEvents.clear();
  }

  public async createImportBatch(
    ctx: TenantContext,
    input: CreateImportBatchInput,
    _tx?: TransactionClient
  ): Promise<ImportBatchEntity> {
    const batchId = input.id || crypto.randomUUID();
    const batch: ImportBatchWithFiles = {
      id: batchId,
      organizationId: ctx.organizationId,
      batchNumber: input.batchNumber,
      engineVersion: input.engineVersion,
      rulesVersion: input.rulesVersion,
      status: BatchStatus.PENDING,
      executionMode: input.executionMode || 'STANDARD',
      reprocessReason: input.reprocessReason || null,
      parentBatchId: input.parentBatchId || null,
      startedAt: new Date(),
      completedAt: null,
      totalRecordsProcessed: 0,
      configuration: input.configuration || {},
      gstRegistrationId: input.gstRegistrationId || null,
      sourcePlatform: input.sourcePlatform || 'AMAZON',
      fileAssociations: []
    };

    this.batches.set(`${ctx.organizationId}#${batchId}`, batch);
    return batch;
  }

  public async getImportById(
    ctx: TenantContext,
    batchId: string,
    _tx?: TransactionClient
  ): Promise<ImportBatchWithFiles | null> {
    const found = this.batches.get(`${ctx.organizationId}#${batchId}`);
    return found ? { ...found } : null;
  }

  public async listImports(
    ctx: TenantContext,
    query: ListImportsQuery,
    _tx?: TransactionClient
  ): Promise<{ items: ImportBatchWithFiles[]; total: number }> {
    let all = Array.from(this.batches.values()).filter(
      (b) => b.organizationId === ctx.organizationId
    );

    if (query.status) {
      all = all.filter((b) => b.status === query.status);
    }
    if (query.gstRegistrationId) {
      all = all.filter((b) => b.gstRegistrationId === query.gstRegistrationId);
    }
    if (query.sourcePlatform) {
      all = all.filter((b) => b.sourcePlatform === query.sourcePlatform);
    }
    if (query.from) {
      const fromDate = new Date(query.from).getTime();
      all = all.filter((b) => new Date(b.startedAt).getTime() >= fromDate);
    }
    if (query.to) {
      const toDate = new Date(query.to).getTime();
      all = all.filter((b) => new Date(b.startedAt).getTime() <= toDate);
    }

    const sortOrder = query.sortOrder || 'desc';
    all.sort((a, b) => {
      const timeA = new Date(a.startedAt).getTime();
      const timeB = new Date(b.startedAt).getTime();
      return sortOrder === 'asc' ? timeA - timeB : timeB - timeA;
    });

    const page = query.page || 1;
    const limit = query.limit || 20;
    const start = (page - 1) * limit;
    const paged = all.slice(start, start + limit);

    return { items: paged, total: all.length };
  }

  public async getLatestJobForBatch(
    ctx: TenantContext,
    batchId: string,
    _tx?: TransactionClient
  ): Promise<ProcessingJobEntity | null> {
    const matching = Array.from(this.jobs.values()).filter(
      (j) => j.organizationId === ctx.organizationId && j.importBatchId === batchId
    );
    if (matching.length === 0) return null;
    matching.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return matching[0];
  }

  public async getImportSummary(
    ctx: TenantContext,
    batchId: string,
    _tx?: TransactionClient
  ): Promise<ImportSummaryResponseDto | null> {
    const batch = await this.getImportById(ctx, batchId);
    if (!batch) return null;

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
      metrics: null,
      persistedCounts: {
        invoices: 0,
        creditNotes: 0,
        stockTransfers: 0,
        reconciliations: 0,
        validationIssues: 0
      }
    };
  }

  public async createJobAndOutbox(
    ctx: TenantContext,
    input: {
      processingJobId: string;
      batchId: string;
      filePaths: string[];
      configuration?: Record<string, unknown>;
    },
    _tx?: TransactionClient
  ): Promise<{ job: ProcessingJobEntity; outbox: OutboxEventEntity }> {
    const job: ProcessingJobEntity = {
      id: input.processingJobId,
      organizationId: ctx.organizationId,
      importBatchId: input.batchId,
      jobType: 'BATCH_PROCESSING',
      status: JobStatus.QUEUED,
      executionCheckpoint: ExecutionCheckpoint.DOMAIN_PROCESSING,
      attempts: 0,
      maxAttempts: 3,
      bullmqJobId: null,
      executionMode: BatchExecutionMode.INGESTION,
      startedAt: null,
      completedAt: null,
      failedAt: null,
      lastError: null,
      errorStack: null,
      metadata: input.configuration || {},
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const outbox: OutboxEventEntity = {
      id: crypto.randomUUID(),
      organizationId: ctx.organizationId,
      eventType: 'BATCH_PROCESSING',
      payload: {
        processingJobId: input.processingJobId,
        organizationId: ctx.organizationId,
        importBatchId: input.batchId,
        filePaths: input.filePaths,
        executionMode: 'STANDARD',
        configuration: input.configuration || {}
      },
      status: OutboxStatus.PENDING,
      claimedBy: null,
      leaseExpiresAt: null,
      publishedAt: null,
      attempts: 0,
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    this.jobs.set(`${ctx.organizationId}#${job.id}`, job);
    this.outboxEvents.set(`${ctx.organizationId}#${outbox.id}`, outbox);

    return { job, outbox };
  }

  // Test helper to simulate job completion or association
  public addFileAssociation(
    orgId: string,
    batchId: string,
    assoc: ImportBatchWithFiles['fileAssociations'][0]
  ): void {
    const key = `${orgId}#${batchId}`;
    const batch = this.batches.get(key);
    if (batch) {
      batch.fileAssociations.push(assoc);
    }
  }

  public updateBatchStatus(orgId: string, batchId: string, status: BatchStatus): void {
    const key = `${orgId}#${batchId}`;
    const batch = this.batches.get(key);
    if (batch) {
      batch.status = status;
    }
  }
}
