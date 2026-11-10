import crypto from 'crypto';
import {
  IImportBatchRepository,
  ISourceRecordRepository,
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
  DuplicateBatchAssociationError,
  TenantAuthorizationError
} from '../types.js';

const PERMITTED_STATUS_TRANSITIONS: Record<BatchStatus, BatchStatus[]> = {
  [BatchStatus.PENDING]: [BatchStatus.PROCESSING, BatchStatus.FAILED],
  [BatchStatus.PROCESSING]: [BatchStatus.COMPLETED, BatchStatus.FAILED],
  [BatchStatus.COMPLETED]: [],
  [BatchStatus.FAILED]: []
};

export class InMemoryImportBatchRepository implements IImportBatchRepository {
  private batchesById = new Map<string, ImportBatchEntity>();
  private batchesByNumber = new Map<string, ImportBatchEntity>();
  private associations = new Map<string, BatchSourceFileEntity>();

  constructor(private readonly sourceRecordRepo?: ISourceRecordRepository) {}

  public reset(): void {
    this.batchesById.clear();
    this.batchesByNumber.clear();
    this.associations.clear();
  }

  private validateTenant(ctx: TenantContext): void {
    if (!ctx || !ctx.organizationId) {
      throw new TenantAuthorizationError('Tenant context is missing or invalid.');
    }
  }

  public async createBatch(
    ctx: TenantContext,
    input: CreateImportBatchInput
  ): Promise<ImportBatchEntity> {
    this.validateTenant(ctx);

    if (input.parentBatchId) {
      const parent = await this.getBatchById(ctx, input.parentBatchId);
      if (!parent) {
        throw new BatchNotFoundError(input.parentBatchId, ctx.organizationId);
      }
    }

    if (input.sourceFileIds && this.sourceRecordRepo) {
      for (const sfId of input.sourceFileIds) {
        const file = await this.sourceRecordRepo.findSourceFileById(ctx, sfId);
        if (!file) {
          throw new SourceFileNotFoundError(sfId, ctx.organizationId);
        }
      }
    }

    const batch: ImportBatchEntity = {
      id: input.id || crypto.randomUUID(),
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
      sourcePlatform: input.sourcePlatform || 'AMAZON'
    };

    const idKey = `${ctx.organizationId}#${batch.id}`;
    const numKey = `${ctx.organizationId}#${batch.batchNumber}`;
    this.batchesById.set(idKey, batch);
    this.batchesByNumber.set(numKey, batch);

    if (input.sourceFileIds) {
      for (const sfId of input.sourceFileIds) {
        await this.associateSourceFile(ctx, batch.id, sfId, FileBatchStatus.QUEUED);
      }
    }

    return batch;
  }

  public async getBatchById(
    ctx: TenantContext,
    batchId: string
  ): Promise<ImportBatchWithFiles | null> {
    this.validateTenant(ctx);
    const idKey = `${ctx.organizationId}#${batchId}`;
    const batch = this.batchesById.get(idKey);
    if (!batch) return null;

    const fileAssocs: (BatchSourceFileEntity & { sourceFile: any })[] = [];
    for (const assoc of this.associations.values()) {
      if (
        assoc.organizationId === ctx.organizationId &&
        assoc.importBatchId === batchId
      ) {
        let sf: any = null;
        if (this.sourceRecordRepo) {
          sf = await this.sourceRecordRepo.findSourceFileById(ctx, assoc.sourceFileId);
        }
        fileAssocs.push({
          ...assoc,
          sourceFile: sf || {
            id: assoc.sourceFileId,
            organizationId: ctx.organizationId,
            fileName: 'unknown',
            fileFingerprint: 'unknown',
            fileSizeBytes: 0n,
            storageUri: '',
            reportPeriod: null,
            sourceReportType: 'UNKNOWN',
            totalPhysicalLines: 0,
            uploadedAt: new Date()
          }
        });
      }
    }

    let parentBatch: ImportBatchEntity | null = null;
    if (batch.parentBatchId) {
      parentBatch =
        this.batchesById.get(`${ctx.organizationId}#${batch.parentBatchId}`) || null;
    }

    return {
      ...batch,
      fileAssociations: fileAssocs,
      parentBatch
    };
  }

  public async getBatchByNumber(
    ctx: TenantContext,
    batchNumber: string
  ): Promise<ImportBatchEntity | null> {
    this.validateTenant(ctx);
    const numKey = `${ctx.organizationId}#${batchNumber}`;
    return this.batchesByNumber.get(numKey) || null;
  }

  public async updateBatchStatus(
    ctx: TenantContext,
    batchId: string,
    currentStatus: BatchStatus,
    newStatus: BatchStatus,
    metadata?: UpdateBatchStatusMetadata
  ): Promise<ImportBatchEntity> {
    this.validateTenant(ctx);

    const permitted = PERMITTED_STATUS_TRANSITIONS[currentStatus];
    if (!permitted || !permitted.includes(newStatus)) {
      throw new IllegalBatchStatusTransitionError(batchId, currentStatus, newStatus);
    }

    const idKey = `${ctx.organizationId}#${batchId}`;
    const batch = this.batchesById.get(idKey);
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

    const updated: ImportBatchEntity = {
      ...batch,
      status: newStatus,
      completedAt: isTerminal ? metadata?.completedAt || new Date() : batch.completedAt,
      totalRecordsProcessed:
        metadata?.totalRecordsProcessed !== undefined
          ? metadata.totalRecordsProcessed
          : batch.totalRecordsProcessed
    };

    this.batchesById.set(idKey, updated);
    this.batchesByNumber.set(`${ctx.organizationId}#${updated.batchNumber}`, updated);

    return updated;
  }

  public async associateSourceFile(
    ctx: TenantContext,
    batchId: string,
    sourceFileId: string,
    initialStatus: FileBatchStatus = FileBatchStatus.QUEUED
  ): Promise<BatchSourceFileEntity> {
    this.validateTenant(ctx);

    const idKey = `${ctx.organizationId}#${batchId}`;
    const batch = this.batchesById.get(idKey);
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

    if (this.sourceRecordRepo) {
      const file = await this.sourceRecordRepo.findSourceFileById(ctx, sourceFileId);
      if (!file) {
        throw new SourceFileNotFoundError(sourceFileId, ctx.organizationId);
      }
    }

    const assocKey = `${ctx.organizationId}#${batchId}#${sourceFileId}`;
    if (this.associations.has(assocKey)) {
      throw new DuplicateBatchAssociationError(batchId, sourceFileId);
    }

    const assoc: BatchSourceFileEntity = {
      id: crypto.randomUUID(),
      organizationId: ctx.organizationId,
      importBatchId: batchId,
      sourceFileId,
      fileStatus: initialStatus,
      processedLines: 0,
      errorSummary: null
    };

    this.associations.set(assocKey, assoc);
    return assoc;
  }

  public async updateBatchSourceFileStatus(
    ctx: TenantContext,
    batchId: string,
    sourceFileId: string,
    fileStatus: FileBatchStatus,
    processedLines?: number,
    errorSummary?: string | null
  ): Promise<BatchSourceFileEntity> {
    this.validateTenant(ctx);
    const assocKey = `${ctx.organizationId}#${batchId}#${sourceFileId}`;
    const assoc = this.associations.get(assocKey);
    if (!assoc) {
      throw new BatchNotFoundError(
        `Association between batch '${batchId}' and source file '${sourceFileId}' not found`,
        ctx.organizationId
      );
    }

    const updated: BatchSourceFileEntity = {
      ...assoc,
      fileStatus,
      processedLines:
        processedLines !== undefined ? processedLines : assoc.processedLines,
      errorSummary: errorSummary !== undefined ? errorSummary : assoc.errorSummary
    };

    this.associations.set(assocKey, updated);
    return updated;
  }

  public async createReprocessingBatch(
    ctx: TenantContext,
    input: CreateReprocessingBatchInput
  ): Promise<ImportBatchEntity> {
    this.validateTenant(ctx);

    const parent = await this.getBatchById(ctx, input.parentBatchId);
    if (!parent) {
      throw new BatchNotFoundError(input.parentBatchId, ctx.organizationId);
    }

    if (this.sourceRecordRepo) {
      for (const sfId of input.sourceFileIds) {
        const file = await this.sourceRecordRepo.findSourceFileById(ctx, sfId);
        if (!file) {
          throw new SourceFileNotFoundError(sfId, ctx.organizationId);
        }
      }
    }

    const newBatchId = crypto.randomUUID();
    const batch: ImportBatchEntity = {
      id: newBatchId,
      organizationId: ctx.organizationId,
      batchNumber: input.newBatchNumber,
      engineVersion: input.engineVersion || parent.engineVersion,
      rulesVersion: input.rulesVersion || parent.rulesVersion,
      status: BatchStatus.PENDING,
      executionMode: 'REPROCESSING',
      reprocessReason: input.reprocessReason,
      parentBatchId: parent.id,
      startedAt: new Date(),
      completedAt: null,
      totalRecordsProcessed: 0,
      configuration: input.configuration || parent.configuration || {}
    };

    const idKey = `${ctx.organizationId}#${batch.id}`;
    const numKey = `${ctx.organizationId}#${batch.batchNumber}`;
    this.batchesById.set(idKey, batch);
    this.batchesByNumber.set(numKey, batch);

    for (const sfId of input.sourceFileIds) {
      await this.associateSourceFile(ctx, newBatchId, sfId, FileBatchStatus.QUEUED);
    }

    return batch;
  }

  public async listBatches(
    ctx: TenantContext,
    options?: {
      status?: BatchStatus;
      executionMode?: string;
      limit?: number;
      offset?: number;
    }
  ): Promise<ImportBatchEntity[]> {
    this.validateTenant(ctx);

    let list: ImportBatchEntity[] = [];
    for (const batch of this.batchesById.values()) {
      if (batch.organizationId === ctx.organizationId) {
        if (options?.status && batch.status !== options.status) continue;
        if (options?.executionMode && batch.executionMode !== options.executionMode)
          continue;
        list.push(batch);
      }
    }

    list.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

    if (options?.offset !== undefined) {
      list = list.slice(options.offset);
    }
    if (options?.limit !== undefined) {
      list = list.slice(0, options.limit);
    }

    return list;
  }

  public async findBatchSourceFilesBySourceFile(
    ctx: TenantContext,
    sourceFileId: string
  ): Promise<BatchSourceFileEntity[]> {
    this.validateTenant(ctx);
    const results: BatchSourceFileEntity[] = [];
    for (const assoc of this.associations.values()) {
      if (assoc.organizationId === ctx.organizationId && assoc.sourceFileId === sourceFileId) {
        results.push({ ...assoc });
      }
    }
    return results;
  }
}
