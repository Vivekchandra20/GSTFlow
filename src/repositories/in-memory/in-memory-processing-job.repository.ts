import crypto from 'crypto';
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

export class InMemoryProcessingJobRepository implements IProcessingJobRepository {
  private jobs: ProcessingJobEntity[] = [];

  public async createJob(
    ctx: TenantContext,
    input: CreateProcessingJobInput,
    _tx?: TransactionClient
  ): Promise<ProcessingJobEntity> {
    const job: ProcessingJobEntity = {
      id: crypto.randomUUID(),
      organizationId: ctx.organizationId,
      importBatchId: input.importBatchId,
      jobType: input.jobType || 'BATCH_PROCESSING',
      status: JobStatus.QUEUED,
      executionCheckpoint: ExecutionCheckpoint.STAGING,
      attempts: 0,
      maxAttempts: input.maxAttempts || 3,
      bullmqJobId: input.bullmqJobId || null,
      executionMode: input.executionMode || BatchExecutionMode.INGESTION,
      startedAt: null,
      completedAt: null,
      failedAt: null,
      lastError: null,
      errorStack: null,
      metadata: input.metadata || null,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    this.jobs.push(job);
    return { ...job };
  }

  public async resolveJobAuthoritative(jobId: string): Promise<AuthoritativeJobResolution | null> {
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job) return null;
    return {
      id: job.id,
      organizationId: job.organizationId,
      importBatchId: job.importBatchId,
      jobType: job.jobType,
      status: job.status,
      executionCheckpoint: job.executionCheckpoint,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts
    };
  }

  public async updateJobStatus(
    ctx: TenantContext,
    jobId: string,
    status: JobStatus,
    updates?: Partial<Omit<ProcessingJobEntity, 'id' | 'organizationId' | 'importBatchId'>>,
    _tx?: TransactionClient
  ): Promise<ProcessingJobEntity> {
    const job = this.jobs.find((j) => j.id === jobId && j.organizationId === ctx.organizationId);
    if (!job) {
      throw new Error(`Job '${jobId}' not found for organization '${ctx.organizationId}'.`);
    }

    job.status = status;
    if (status === JobStatus.PROCESSING && !job.startedAt) {
      job.startedAt = new Date();
    } else if (status === JobStatus.COMPLETED && !job.completedAt) {
      job.completedAt = new Date();
    } else if (status === JobStatus.FAILED && !job.failedAt) {
      job.failedAt = new Date();
    }

    if (updates) {
      Object.assign(job, updates);
    }
    job.updatedAt = new Date();
    return { ...job };
  }

  public async updateCheckpoint(
    ctx: TenantContext,
    jobId: string,
    checkpoint: ExecutionCheckpoint,
    _tx?: TransactionClient
  ): Promise<ProcessingJobEntity> {
    const job = this.jobs.find((j) => j.id === jobId && j.organizationId === ctx.organizationId);
    if (!job) {
      throw new Error(`Job '${jobId}' not found for organization '${ctx.organizationId}'.`);
    }
    job.executionCheckpoint = checkpoint;
    job.updatedAt = new Date();
    return { ...job };
  }

  public async findById(
    ctx: TenantContext,
    jobId: string,
    _tx?: TransactionClient
  ): Promise<ProcessingJobEntity | null> {
    const job = this.jobs.find((j) => j.id === jobId && j.organizationId === ctx.organizationId);
    return job ? { ...job } : null;
  }

  public async findByBatchId(
    ctx: TenantContext,
    batchId: string,
    _tx?: TransactionClient
  ): Promise<ProcessingJobEntity[]> {
    return this.jobs
      .filter((j) => j.importBatchId === batchId && j.organizationId === ctx.organizationId)
      .map((j) => ({ ...j }));
  }

  public clear(): void {
    this.jobs = [];
  }
}
