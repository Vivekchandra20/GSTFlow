import crypto from 'crypto';
import {
  ISourceRecordRepository,
  TenantContext,
  CreateSourceFileInput,
  SourceFileEntity,
  CreateSourceRecordInput,
  SourceRecordEntity,
  BulkInsertSourceRecordsResult,
  RecordType,
  DuplicateSourceFileError,
  SourceFileNotFoundError,
  TenantAuthorizationError
} from '../types.js';

export class InMemorySourceRecordRepository implements ISourceRecordRepository {
  private filesById = new Map<string, SourceFileEntity>();
  private filesByFingerprint = new Map<string, SourceFileEntity>();
  private recordsById = new Map<string, SourceRecordEntity>();
  private recordsByFileLine = new Map<string, SourceRecordEntity>();

  public reset(): void {
    this.filesById.clear();
    this.filesByFingerprint.clear();
    this.recordsById.clear();
    this.recordsByFileLine.clear();
  }

  private validateTenant(ctx: TenantContext): void {
    if (!ctx || !ctx.organizationId) {
      throw new TenantAuthorizationError('Tenant context is missing or invalid.');
    }
  }

  public async createSourceFile(
    ctx: TenantContext,
    input: CreateSourceFileInput
  ): Promise<SourceFileEntity> {
    this.validateTenant(ctx);

    const fpKey = `${ctx.organizationId}#${input.fileFingerprint}`;
    if (this.filesByFingerprint.has(fpKey)) {
      const existing = this.filesByFingerprint.get(fpKey);
      throw new DuplicateSourceFileError(
        ctx.organizationId,
        input.fileFingerprint,
        existing?.id
      );
    }

    const file: SourceFileEntity = {
      id: input.id || crypto.randomUUID(),
      organizationId: ctx.organizationId,
      fileName: input.fileName,
      fileFingerprint: input.fileFingerprint,
      fileSizeBytes: BigInt(input.fileSizeBytes),
      storageUri: input.storageUri,
      reportPeriod: input.reportPeriod || null,
      sourceReportType: input.sourceReportType,
      totalPhysicalLines: input.totalPhysicalLines ?? 0,
      uploadedAt: new Date()
    };

    const idKey = `${ctx.organizationId}#${file.id}`;
    this.filesById.set(idKey, file);
    this.filesByFingerprint.set(fpKey, file);

    return file;
  }

  public async findSourceFileById(
    ctx: TenantContext,
    sourceFileId: string
  ): Promise<SourceFileEntity | null> {
    this.validateTenant(ctx);
    const idKey = `${ctx.organizationId}#${sourceFileId}`;
    return this.filesById.get(idKey) || null;
  }

  public async findSourceFileByFingerprint(
    ctx: TenantContext,
    fingerprint: string
  ): Promise<SourceFileEntity | null> {
    this.validateTenant(ctx);
    const fpKey = `${ctx.organizationId}#${fingerprint}`;
    return this.filesByFingerprint.get(fpKey) || null;
  }

  public async bulkInsertSourceRecords(
    ctx: TenantContext,
    sourceFileId: string,
    records: CreateSourceRecordInput[]
  ): Promise<BulkInsertSourceRecordsResult> {
    this.validateTenant(ctx);

    const sourceFile = await this.findSourceFileById(ctx, sourceFileId);
    if (!sourceFile) {
      throw new SourceFileNotFoundError(sourceFileId, ctx.organizationId);
    }

    let inserted = 0;
    let skipped = 0;

    for (const r of records) {
      const lineKey = `${sourceFileId}#${r.physicalLineNumber}`;
      if (this.recordsByFileLine.has(lineKey)) {
        skipped++;
        continue;
      }

      const entity: SourceRecordEntity = {
        id: r.id || crypto.randomUUID(),
        organizationId: ctx.organizationId,
        sourceFileId,
        physicalLineNumber: r.physicalLineNumber,
        logicalRecordNumber: r.logicalRecordNumber,
        recordType: r.recordType,
        rawPayload: r.rawPayload,
        createdAt: new Date()
      };

      const idKey = `${ctx.organizationId}#${entity.id}`;
      this.recordsById.set(idKey, entity);
      this.recordsByFileLine.set(lineKey, entity);
      inserted++;
    }

    return {
      insertedCount: inserted,
      skippedCount: skipped,
      totalProvided: records.length
    };
  }

  public async findRecordsBySourceFile(
    ctx: TenantContext,
    sourceFileId: string,
    options?: { limit?: number; offset?: number; recordType?: RecordType }
  ): Promise<SourceRecordEntity[]> {
    this.validateTenant(ctx);

    const sourceFile = await this.findSourceFileById(ctx, sourceFileId);
    if (!sourceFile) {
      throw new SourceFileNotFoundError(sourceFileId, ctx.organizationId);
    }

    let matched: SourceRecordEntity[] = [];
    for (const record of this.recordsById.values()) {
      if (
        record.organizationId === ctx.organizationId &&
        record.sourceFileId === sourceFileId
      ) {
        if (!options?.recordType || record.recordType === options.recordType) {
          matched.push(record);
        }
      }
    }

    matched.sort((a, b) => a.physicalLineNumber - b.physicalLineNumber);

    if (options?.offset !== undefined) {
      matched = matched.slice(options.offset);
    }
    if (options?.limit !== undefined) {
      matched = matched.slice(0, options.limit);
    }

    return matched;
  }

  public async countRecordsBySourceFile(
    ctx: TenantContext,
    sourceFileId: string,
    recordType?: RecordType
  ): Promise<number> {
    const list = await this.findRecordsBySourceFile(ctx, sourceFileId, { recordType });
    return list.length;
  }

  public async findRecordById(
    ctx: TenantContext,
    recordId: string
  ): Promise<SourceRecordEntity | null> {
    this.validateTenant(ctx);
    const idKey = `${ctx.organizationId}#${recordId}`;
    return this.recordsById.get(idKey) || null;
  }

  public async updateSourceFileTotalLines(
    ctx: TenantContext,
    sourceFileId: string,
    totalLines: number,
    _tx?: any
  ): Promise<SourceFileEntity> {
    this.validateTenant(ctx);
    const idKey = `${ctx.organizationId}#${sourceFileId}`;
    const file = this.filesById.get(idKey);
    if (!file) {
      throw new SourceFileNotFoundError(sourceFileId, ctx.organizationId);
    }
    file.totalPhysicalLines = totalLines;
    return { ...file };
  }

  public async findRecordLineMap(
    ctx: TenantContext,
    sourceFileId: string,
    _tx?: any
  ): Promise<Map<number, string>> {
    this.validateTenant(ctx);
    const lineMap = new Map<number, string>();
    for (const record of this.recordsById.values()) {
      if (record.organizationId === ctx.organizationId && record.sourceFileId === sourceFileId) {
        lineMap.set(record.physicalLineNumber, record.id);
      }
    }
    return lineMap;
  }
}
