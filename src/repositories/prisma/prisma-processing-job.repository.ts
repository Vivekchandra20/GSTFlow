import { PrismaClient } from '@prisma/client';
import {
  TenantContext,
  TransactionClient,
  IProcessingJobRepository,
  ProcessingJobEntity,
  CreateProcessingJobInput,
  AuthoritativeJobResolution,
  JobStatus,
  ExecutionCheckpoint,
  BatchExecutionMode
} from '../types.js';
import { runInTenantTransaction } from './tenant-context.js';

export class PrismaProcessingJobRepository implements IProcessingJobRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public async createJob(
    ctx: TenantContext,
    input: CreateProcessingJobInput,
    tx?: TransactionClient
  ): Promise<ProcessingJobEntity> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const created = await (client as any).processingJob.create({
          data: {
            organizationId: ctx.organizationId,
            importBatchId: input.importBatchId,
            jobType: input.jobType || 'BATCH_PROCESSING',
            status: JobStatus.QUEUED,
            executionCheckpoint: ExecutionCheckpoint.STAGING,
            attempts: 0,
            maxAttempts: input.maxAttempts || 3,
            bullmqJobId: input.bullmqJobId || null,
            executionMode: (input.executionMode as any) || BatchExecutionMode.INGESTION,
            metadata: (input.metadata as any) || undefined
          }
        });

        return this.mapToEntity(created);
      },
      tx
    );
  }

  public async resolveJobAuthoritative(jobId: string): Promise<AuthoritativeJobResolution | null> {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        organization_id: string;
        import_batch_id: string;
        job_type: string;
        status: string;
        execution_checkpoint: string;
        attempts: number;
        max_attempts: number;
      }>
    >(`SELECT id, organization_id, import_batch_id, job_type, status, execution_checkpoint, attempts, max_attempts FROM resolve_processing_job($1::uuid);`, jobId);

    if (!rows || rows.length === 0) return null;

    const r = rows[0];
    return {
      id: r.id,
      organizationId: r.organization_id,
      importBatchId: r.import_batch_id,
      jobType: r.job_type,
      status: r.status,
      executionCheckpoint: r.execution_checkpoint,
      attempts: r.attempts,
      maxAttempts: r.max_attempts
    };
  }

  public async updateJobStatus(
    ctx: TenantContext,
    jobId: string,
    status: JobStatus,
    updates?: Partial<Omit<ProcessingJobEntity, 'id' | 'organizationId' | 'importBatchId'>>,
    tx?: TransactionClient
  ): Promise<ProcessingJobEntity> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const data: any = {
          status,
          ...updates
        };

        if (status === JobStatus.PROCESSING && !data.startedAt) {
          data.startedAt = new Date();
        } else if (status === JobStatus.COMPLETED && !data.completedAt) {
          data.completedAt = new Date();
        } else if (status === JobStatus.FAILED && !data.failedAt) {
          data.failedAt = new Date();
        }

        const updated = await (client as any).processingJob.update({
          where: {
            id: jobId,
            organizationId: ctx.organizationId
          },
          data
        });

        return this.mapToEntity(updated);
      },
      tx
    );
  }

  public async updateCheckpoint(
    ctx: TenantContext,
    jobId: string,
    checkpoint: ExecutionCheckpoint,
    tx?: TransactionClient
  ): Promise<ProcessingJobEntity> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const updated = await (client as any).processingJob.update({
          where: {
            id: jobId,
            organizationId: ctx.organizationId
          },
          data: {
            executionCheckpoint: checkpoint
          }
        });

        return this.mapToEntity(updated);
      },
      tx
    );
  }

  public async findById(
    ctx: TenantContext,
    jobId: string,
    tx?: TransactionClient
  ): Promise<ProcessingJobEntity | null> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const found = await (client as any).processingJob.findFirst({
          where: {
            id: jobId,
            organizationId: ctx.organizationId
          }
        });

        if (!found) return null;
        return this.mapToEntity(found);
      },
      tx
    );
  }

  public async findByBatchId(
    ctx: TenantContext,
    batchId: string,
    tx?: TransactionClient
  ): Promise<ProcessingJobEntity[]> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const list = await (client as any).processingJob.findMany({
          where: {
            importBatchId: batchId,
            organizationId: ctx.organizationId
          },
          orderBy: { createdAt: 'desc' }
        });

        return list.map((item: any) => this.mapToEntity(item));
      },
      tx
    );
  }

  private mapToEntity(row: any): ProcessingJobEntity {
    return {
      id: row.id,
      organizationId: row.organizationId,
      importBatchId: row.importBatchId,
      jobType: row.jobType,
      status: row.status as JobStatus,
      executionCheckpoint: row.executionCheckpoint as ExecutionCheckpoint,
      attempts: row.attempts,
      maxAttempts: row.maxAttempts,
      bullmqJobId: row.bullmqJobId,
      executionMode: row.executionMode as BatchExecutionMode,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      failedAt: row.failedAt,
      lastError: row.lastError,
      errorStack: row.errorStack,
      metadata: row.metadata,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
  }
}
