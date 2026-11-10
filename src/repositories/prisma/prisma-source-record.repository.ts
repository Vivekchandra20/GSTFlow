import crypto from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
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
  SourceFileNotFoundError
} from '../types.js';
import { runInTenantTransaction } from './tenant-context.js';

export class PrismaSourceRecordRepository implements ISourceRecordRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public async createSourceFile(
    ctx: TenantContext,
    input: CreateSourceFileInput,
    tx?: Prisma.TransactionClient
  ): Promise<SourceFileEntity> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        // Pre-check for duplicate fingerprint to avoid transaction abort and retrieve existing ID
        const existing = await client.sourceFile.findFirst({
          where: {
            organizationId: ctx.organizationId,
            fileFingerprint: input.fileFingerprint
          }
        });
        if (existing) {
          throw new DuplicateSourceFileError(
            ctx.organizationId,
            input.fileFingerprint,
            existing.id
          );
        }

        try {
          const created = await client.sourceFile.create({
            data: {
              id: input.id || crypto.randomUUID(),
              organizationId: ctx.organizationId,
              fileName: input.fileName,
              fileFingerprint: input.fileFingerprint,
              fileSizeBytes: BigInt(input.fileSizeBytes),
              storageUri: input.storageUri,
              reportPeriod: input.reportPeriod || null,
              sourceReportType: input.sourceReportType,
              totalPhysicalLines: input.totalPhysicalLines ?? 0
            }
          });

          return {
            id: created.id,
            organizationId: created.organizationId,
            fileName: created.fileName,
            fileFingerprint: created.fileFingerprint,
            fileSizeBytes: created.fileSizeBytes,
            storageUri: created.storageUri,
            reportPeriod: created.reportPeriod,
            sourceReportType: created.sourceReportType,
            totalPhysicalLines: created.totalPhysicalLines,
            uploadedAt: created.uploadedAt
          };
        } catch (error: any) {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
          ) {
            throw new DuplicateSourceFileError(
              ctx.organizationId,
              input.fileFingerprint
            );
          }
          throw error;
        }
      },
      tx
    );
  }

  public async findSourceFileById(
    ctx: TenantContext,
    sourceFileId: string,
    tx?: Prisma.TransactionClient
  ): Promise<SourceFileEntity | null> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const file = await client.sourceFile.findFirst({
          where: {
            id: sourceFileId,
            organizationId: ctx.organizationId
          }
        });
        if (!file) return null;
        return {
          id: file.id,
          organizationId: file.organizationId,
          fileName: file.fileName,
          fileFingerprint: file.fileFingerprint,
          fileSizeBytes: file.fileSizeBytes,
          storageUri: file.storageUri,
          reportPeriod: file.reportPeriod,
          sourceReportType: file.sourceReportType,
          totalPhysicalLines: file.totalPhysicalLines,
          uploadedAt: file.uploadedAt
        };
      },
      tx
    );
  }

  public async findSourceFileByFingerprint(
    ctx: TenantContext,
    fingerprint: string,
    tx?: Prisma.TransactionClient
  ): Promise<SourceFileEntity | null> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const file = await client.sourceFile.findFirst({
          where: {
            organizationId: ctx.organizationId,
            fileFingerprint: fingerprint
          }
        });
        if (!file) return null;
        return {
          id: file.id,
          organizationId: file.organizationId,
          fileName: file.fileName,
          fileFingerprint: file.fileFingerprint,
          fileSizeBytes: file.fileSizeBytes,
          storageUri: file.storageUri,
          reportPeriod: file.reportPeriod,
          sourceReportType: file.sourceReportType,
          totalPhysicalLines: file.totalPhysicalLines,
          uploadedAt: file.uploadedAt
        };
      },
      tx
    );
  }

  public async bulkInsertSourceRecords(
    ctx: TenantContext,
    sourceFileId: string,
    records: CreateSourceRecordInput[],
    tx?: Prisma.TransactionClient
  ): Promise<BulkInsertSourceRecordsResult> {
    if (records.length === 0) {
      return { insertedCount: 0, skippedCount: 0, totalProvided: 0 };
    }

    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        // Enforce source file ownership before record insertion
        const sourceFile = await client.sourceFile.findFirst({
          where: {
            id: sourceFileId,
            organizationId: ctx.organizationId
          }
        });
        if (!sourceFile) {
          throw new SourceFileNotFoundError(sourceFileId, ctx.organizationId);
        }

        const CHUNK_SIZE = 1000;
        let totalInserted = 0;

        for (let i = 0; i < records.length; i += CHUNK_SIZE) {
          const chunk = records.slice(i, i + CHUNK_SIZE);
          const data: Prisma.SourceRecordCreateManyInput[] = chunk.map((r) => ({
            id: r.id || crypto.randomUUID(),
            organizationId: ctx.organizationId,
            sourceFileId,
            physicalLineNumber: r.physicalLineNumber,
            logicalRecordNumber: r.logicalRecordNumber,
            recordType: r.recordType,
            rawPayload: r.rawPayload as Prisma.InputJsonValue
          }));

          const res = await client.sourceRecord.createMany({
            data,
            skipDuplicates: true
          });
          totalInserted += res.count;
        }

        return {
          insertedCount: totalInserted,
          skippedCount: records.length - totalInserted,
          totalProvided: records.length
        };
      },
      tx
    );
  }

  public async findRecordsBySourceFile(
    ctx: TenantContext,
    sourceFileId: string,
    options?: { limit?: number; offset?: number; recordType?: RecordType },
    tx?: Prisma.TransactionClient
  ): Promise<SourceRecordEntity[]> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const sourceFile = await client.sourceFile.findFirst({
          where: {
            id: sourceFileId,
            organizationId: ctx.organizationId
          }
        });
        if (!sourceFile) {
          throw new SourceFileNotFoundError(sourceFileId, ctx.organizationId);
        }

        const records = await client.sourceRecord.findMany({
          where: {
            sourceFileId,
            organizationId: ctx.organizationId,
            ...(options?.recordType ? { recordType: options.recordType } : {})
          },
          orderBy: { physicalLineNumber: 'asc' },
          take: options?.limit,
          skip: options?.offset
        });

        return records.map((r) => ({
          id: r.id,
          organizationId: r.organizationId,
          sourceFileId: r.sourceFileId,
          physicalLineNumber: r.physicalLineNumber,
          logicalRecordNumber: r.logicalRecordNumber,
          recordType: r.recordType,
          rawPayload: r.rawPayload,
          createdAt: r.createdAt
        }));
      },
      tx
    );
  }

  public async countRecordsBySourceFile(
    ctx: TenantContext,
    sourceFileId: string,
    recordType?: RecordType,
    tx?: Prisma.TransactionClient
  ): Promise<number> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const sourceFile = await client.sourceFile.findFirst({
          where: {
            id: sourceFileId,
            organizationId: ctx.organizationId
          }
        });
        if (!sourceFile) {
          throw new SourceFileNotFoundError(sourceFileId, ctx.organizationId);
        }

        return client.sourceRecord.count({
          where: {
            sourceFileId,
            organizationId: ctx.organizationId,
            ...(recordType ? { recordType } : {})
          }
        });
      },
      tx
    );
  }

  public async findRecordById(
    ctx: TenantContext,
    recordId: string,
    tx?: Prisma.TransactionClient
  ): Promise<SourceRecordEntity | null> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const record = await client.sourceRecord.findFirst({
          where: {
            id: recordId,
            organizationId: ctx.organizationId
          }
        });
        if (!record) return null;
        return {
          id: record.id,
          organizationId: record.organizationId,
          sourceFileId: record.sourceFileId,
          physicalLineNumber: record.physicalLineNumber,
          logicalRecordNumber: record.logicalRecordNumber,
          recordType: record.recordType,
          rawPayload: record.rawPayload,
          createdAt: record.createdAt
        };
      },
      tx
    );
  }

  public async updateSourceFileTotalLines(
    ctx: TenantContext,
    sourceFileId: string,
    totalLines: number,
    tx?: Prisma.TransactionClient
  ): Promise<SourceFileEntity> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const file = await client.sourceFile.findFirst({
          where: {
            id: sourceFileId,
            organizationId: ctx.organizationId
          }
        });
        if (!file) {
          throw new SourceFileNotFoundError(sourceFileId, ctx.organizationId);
        }

        const updated = await client.sourceFile.update({
          where: { id: sourceFileId },
          data: { totalPhysicalLines: totalLines }
        });

        return {
          id: updated.id,
          organizationId: updated.organizationId,
          fileName: updated.fileName,
          fileFingerprint: updated.fileFingerprint,
          fileSizeBytes: updated.fileSizeBytes,
          storageUri: updated.storageUri,
          reportPeriod: updated.reportPeriod,
          sourceReportType: updated.sourceReportType,
          totalPhysicalLines: updated.totalPhysicalLines,
          uploadedAt: updated.uploadedAt
        };
      },
      tx
    );
  }

  public async findRecordLineMap(
    ctx: TenantContext,
    sourceFileId: string,
    tx?: Prisma.TransactionClient
  ): Promise<Map<number, string>> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const records = await client.sourceRecord.findMany({
          where: {
            sourceFileId,
            organizationId: ctx.organizationId
          },
          select: {
            id: true,
            physicalLineNumber: true
          }
        });

        const lineMap = new Map<number, string>();
        for (const r of records) {
          lineMap.set(r.physicalLineNumber, r.id);
        }
        return lineMap;
      },
      tx
    );
  }
}
