import { Worker, Job } from 'bullmq';
import { pino } from 'pino';
import {
  TenantContext,
  IProcessingJobRepository,
  JobStatus,
  ExecutionCheckpoint
} from '../../repositories/types.js';
import { BatchProcessingJobPayload, BatchProcessingJobResult } from './job.types.js';
import { BATCH_PROCESSING_QUEUE_NAME } from './queue.service.js';
import { RedisConnectionManager, RedisConnectionConfig } from './redis.connection.js';
import { PersistentPipelineOrchestrator } from '../../application/persistent-pipeline/persistent-pipeline-orchestrator.js';
import {
  TenantAuthorizationError,
  PersistenceExecutionError
} from '../../application/persistent-pipeline/persistent-pipeline.errors.js';

const logger = pino({ name: 'batch-processing-worker' });

export interface BatchProcessingWorkerOptions {
  orchestrator: PersistentPipelineOrchestrator;
  jobRepo: IProcessingJobRepository;
  redisConfig?: RedisConnectionConfig;
  concurrency?: number;
  autorun?: boolean;
  lockDuration?: number;
  stalledInterval?: number;
  maxStalledCount?: number;
}

export class BatchProcessingWorker {
  private readonly orchestrator: PersistentPipelineOrchestrator;
  private readonly jobRepo: IProcessingJobRepository;
  private readonly worker: Worker<BatchProcessingJobPayload, BatchProcessingJobResult>;

  constructor(options: BatchProcessingWorkerOptions) {
    this.orchestrator = options.orchestrator;
    this.jobRepo = options.jobRepo;

    const connection = RedisConnectionManager.getInstance(options.redisConfig).getClient();

    this.worker = new Worker<BatchProcessingJobPayload, BatchProcessingJobResult>(
      BATCH_PROCESSING_QUEUE_NAME,
      async (job: Job<BatchProcessingJobPayload>) => {
        return this.processJob(job);
      },
      {
        connection,
        concurrency: options.concurrency || 2,
        autorun: options.autorun ?? true,
        lockDuration: options.lockDuration || 30000,
        stalledInterval: options.stalledInterval || 30000,
        maxStalledCount: options.maxStalledCount ?? 1
      }
    );

    this.worker.on('completed', (job: Job<BatchProcessingJobPayload>) => {
      logger.info({
        event: 'WORKER_JOB_COMPLETED',
        bullmqJobId: job.id,
        processingJobId: job.data.processingJobId
      }, 'Job completed successfully by worker.');
    });

    this.worker.on('failed', (job: Job<BatchProcessingJobPayload> | undefined, err: Error) => {
      logger.error({
        event: 'WORKER_JOB_FAILED',
        bullmqJobId: job?.id,
        processingJobId: job?.data.processingJobId,
        err: err.message
      }, 'Job failed in worker.');
    });
  }

  /**
   * Processes a single background job with authoritative tenant resolution,
   * idempotency protection, checkpoint tracking, and bounded error recovery.
   */
  public async processJob(job: Job<BatchProcessingJobPayload>): Promise<BatchProcessingJobResult> {
    const payload = job.data;
    const { processingJobId } = payload;
    const startTime = Date.now();

    logger.info({
      event: 'WORKER_JOB_RECEIVED',
      bullmqJobId: job.id,
      processingJobId,
      untrustedPayloadOrg: payload.organizationId
    }, 'Worker dequeued batch processing job.');

    // 1. Authoritative Job Resolution (SECURITY DEFINER, no untrusted payload orgId)
    const authoritativeJob = await this.jobRepo.resolveJobAuthoritative(processingJobId);
    if (!authoritativeJob) {
      throw new PersistenceExecutionError(`Processing job '${processingJobId}' not found in database.`, {
        batchId: payload.importBatchId
      });
    }

    // 2. Tenant Spoofing Defense: Verify payload org matches database record
    if (payload.organizationId && payload.organizationId !== authoritativeJob.organizationId) {
      const err = new TenantAuthorizationError(
        `Security Alert: Payload organization '${payload.organizationId}' does not match authoritative job organization '${authoritativeJob.organizationId}'. Rejecting execution.`,
        {
          organizationId: authoritativeJob.organizationId,
          batchId: authoritativeJob.importBatchId
        }
      );
      logger.error({
        event: 'TENANT_SPOOFING_ATTEMPT',
        payloadOrg: payload.organizationId,
        authoritativeOrg: authoritativeJob.organizationId,
        processingJobId
      }, err.message);
      throw err;
    }

    const tenantCtx: TenantContext = { organizationId: authoritativeJob.organizationId };

    // 3. Duplicate Delivery Check (Scenario A: At-least-once idempotency guard)
    if (authoritativeJob.status === JobStatus.COMPLETED) {
      logger.warn({
        event: 'DUPLICATE_DELIVERY_SKIPPED',
        processingJobId,
        bullmqJobId: job.id
      }, 'Job was already completed. Skipping execution idempotently.');

      return {
        processingJobId,
        importBatchId: authoritativeJob.importBatchId,
        organizationId: authoritativeJob.organizationId,
        checkpoint: ExecutionCheckpoint.COMPLETED,
        invoiceCount: 0,
        creditNoteCount: 0,
        reconciliationCount: 0,
        durationMs: Date.now() - startTime
      };
    }

    // 4. Update Job Status to PROCESSING under Tenant RLS
    await this.jobRepo.updateJobStatus(tenantCtx, processingJobId, JobStatus.PROCESSING, {
      startedAt: new Date(),
      bullmqJobId: job.id || undefined
    });
    await this.jobRepo.updateCheckpoint(tenantCtx, processingJobId, ExecutionCheckpoint.DOMAIN_PROCESSING);

    try {
      // 5. Execute Domain Processing and Chunked Persistence
      const result = await this.orchestrator.processStagedBatch(tenantCtx, {
        importBatchId: authoritativeJob.importBatchId,
        filePaths: payload.filePaths,
        processingJobId,
        isLiveBatch: payload.isLiveBatch,
        persistenceChunkSize: payload.persistenceChunkSize,
        onCheckpoint: async (checkpoint: ExecutionCheckpoint) => {
          await this.jobRepo.updateCheckpoint(tenantCtx, processingJobId, checkpoint);
        }
      });

      // 6. Checkpoint Transitions to Terminal COMPLETED
      await this.jobRepo.updateCheckpoint(tenantCtx, processingJobId, ExecutionCheckpoint.COMPLETED);
      await this.jobRepo.updateJobStatus(tenantCtx, processingJobId, JobStatus.COMPLETED, {
        completedAt: new Date()
      });

      const durationMs = Date.now() - startTime;
      return {
        processingJobId,
        importBatchId: authoritativeJob.importBatchId,
        organizationId: authoritativeJob.organizationId,
        checkpoint: ExecutionCheckpoint.COMPLETED,
        invoiceCount: result.persistenceResult?.invoicesPersisted || 0,
        creditNoteCount: result.persistenceResult?.creditNotesPersisted || 0,
        reconciliationCount: result.persistenceResult?.reconciliationsCreated || 0,
        durationMs
      };
    } catch (err: any) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isLastAttempt = (job.attemptsMade + 1) >= (authoritativeJob.maxAttempts || 3);
      const nextStatus = isLastAttempt ? JobStatus.FAILED : JobStatus.RETRYING;

      logger.error({
        event: 'WORKER_JOB_EXECUTION_ERROR',
        processingJobId,
        attemptsMade: job.attemptsMade + 1,
        maxAttempts: authoritativeJob.maxAttempts,
        nextStatus,
        err: errMsg
      }, `Job execution failed: ${errMsg}`);

      try {
        await this.jobRepo.updateJobStatus(tenantCtx, processingJobId, nextStatus, {
          lastError: errMsg,
          errorStack: err instanceof Error ? err.stack : undefined,
          failedAt: isLastAttempt ? new Date() : undefined
        });
      } catch (updateErr) {
        logger.error({
          event: 'JOB_STATUS_UPDATE_FAILURE',
          processingJobId,
          err: (updateErr as Error).message
        }, 'Failed to record job failure status.');
      }

      throw err;
    }
  }

  public getWorker(): Worker<BatchProcessingJobPayload, BatchProcessingJobResult> {
    return this.worker;
  }

  public setupGracefulShutdown(signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM']): void {
    for (const sig of signals) {
      process.once(sig, async () => {
        logger.info({ event: 'WORKER_SIGNAL_RECEIVED', signal: sig }, `Received ${sig}. Shutting down worker gracefully...`);
        try {
          await this.close();
        } catch (err) {
          logger.error({ event: 'WORKER_SHUTDOWN_ERROR', err: (err as Error).message }, 'Error during graceful shutdown.');
        }
      });
    }
  }

  public async close(): Promise<void> {
    await this.worker.close();
  }
}
