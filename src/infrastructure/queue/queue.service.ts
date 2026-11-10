import { Queue, JobsOptions } from 'bullmq';
import { pino } from 'pino';
import { BatchProcessingJobPayload } from './job.types.js';
import { RedisConnectionManager, RedisConnectionConfig } from './redis.connection.js';

const logger = pino({ name: 'queue-service' });

export const BATCH_PROCESSING_QUEUE_NAME = 'gstflow-batch-processing';

/**
 * Generates a safe, deterministic BullMQ job ID for an outbox event.
 * Colon ':' is avoided because BullMQ uses colons as Redis key delimiters.
 */
export function buildDeterministicJobId(outboxEventId: string): string {
  return `gstflow-outbox-${outboxEventId}`;
}

export interface IQueueService {
  enqueueBatchProcessing(
    outboxEventId: string,
    payload: BatchProcessingJobPayload,
    options?: Partial<JobsOptions>
  ): Promise<string>;
  close(): Promise<void>;
}

export class BullMQQueueService implements IQueueService {
  private queue: Queue<BatchProcessingJobPayload>;

  constructor(redisConfig?: RedisConnectionConfig) {
    const connection = RedisConnectionManager.getInstance(redisConfig).getClient();
    this.queue = new Queue<BatchProcessingJobPayload>(BATCH_PROCESSING_QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 1000
        },
        removeOnComplete: {
          count: 1000,
          age: 24 * 3600
        },
        removeOnFail: {
          count: 5000,
          age: 7 * 24 * 3600
        }
      }
    });
  }

  public async enqueueBatchProcessing(
    outboxEventId: string,
    payload: BatchProcessingJobPayload,
    options?: Partial<JobsOptions>
  ): Promise<string> {
    const deterministicJobId = buildDeterministicJobId(outboxEventId);

    logger.info({
      event: 'ENQUEUE_BATCH_JOB',
      jobId: deterministicJobId,
      outboxEventId,
      processingJobId: payload.processingJobId,
      importBatchId: payload.importBatchId,
      organizationId: payload.organizationId
    }, 'Enqueuing batch processing job to BullMQ');

    const job = await this.queue.add('process-staged-batch', payload, {
      jobId: deterministicJobId,
      ...options
    });

    return job.id || deterministicJobId;
  }

  public getQueue(): Queue<BatchProcessingJobPayload> {
    return this.queue;
  }

  public async close(): Promise<void> {
    await this.queue.close();
  }
}
