import crypto from 'crypto';
import { pino } from 'pino';
import { IOutboxRepository, ClaimedOutboxEvent } from '../../repositories/types.js';
import { IQueueService } from './queue.service.js';
import { BatchProcessingJobPayload } from './job.types.js';

const logger = pino({ name: 'outbox-dispatcher' });

export interface OutboxDispatcherOptions {
  outboxRepo: IOutboxRepository;
  queueService: IQueueService;
  dispatcherId?: string;
  batchSize?: number;
  leaseSeconds?: number;
  pollIntervalMs?: number;
}

export class OutboxDispatcher {
  private readonly outboxRepo: IOutboxRepository;
  private readonly queueService: IQueueService;
  private readonly dispatcherId: string;
  private readonly batchSize: number;
  private readonly leaseSeconds: number;
  private readonly pollIntervalMs: number;

  private isRunning: boolean = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: OutboxDispatcherOptions) {
    this.outboxRepo = options.outboxRepo;
    this.queueService = options.queueService;
    this.dispatcherId = options.dispatcherId || `dispatcher-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    this.batchSize = options.batchSize || 50;
    this.leaseSeconds = options.leaseSeconds || 30;
    this.pollIntervalMs = options.pollIntervalMs || 1000;
  }

  public getDispatcherId(): string {
    return this.dispatcherId;
  }

  /**
   * Performs an atomic claim and dispatch cycle.
   * Phase 1: Atomically claim events with FOR UPDATE SKIP LOCKED (DB Tx commits).
   * Phase 2: Send to BullMQ / Redis (NO open DB Tx).
   * Phase 3: Mark published or failed in short-lived DB operations.
   */
  public async dispatchOnce(batchSize?: number): Promise<{ claimed: number; published: number; failed: number }> {
    const limit = batchSize || this.batchSize;

    // Phase 1: Claim pending or expired-lease events atomically
    let claimedEvents: ClaimedOutboxEvent[];
    try {
      claimedEvents = await this.outboxRepo.claimEvents(this.dispatcherId, limit, this.leaseSeconds);
    } catch (err) {
      logger.error({ err: (err as Error).message, dispatcherId: this.dispatcherId }, 'Error claiming outbox events');
      return { claimed: 0, published: 0, failed: 0 };
    }

    if (claimedEvents.length === 0) {
      return { claimed: 0, published: 0, failed: 0 };
    }

    logger.info({
      event: 'OUTBOX_EVENTS_CLAIMED',
      dispatcherId: this.dispatcherId,
      count: claimedEvents.length
    }, `Claimed ${claimedEvents.length} outbox events for dispatch.`);

    let publishedCount = 0;
    let failedCount = 0;

    // Phase 2 & 3: Dispatch outside of DB claim transaction
    for (const event of claimedEvents) {
      try {
        const payload = event.payload as BatchProcessingJobPayload;
        await this.queueService.enqueueBatchProcessing(event.id, payload);

        // Mark published under this dispatcher's active lease
        const published = await this.outboxRepo.markPublished(event.id, this.dispatcherId);
        if (published) {
          publishedCount++;
          logger.info({
            event: 'OUTBOX_EVENT_PUBLISHED',
            dispatcherId: this.dispatcherId,
            eventId: event.id
          }, `Published outbox event ${event.id} to queue.`);
        } else {
          logger.warn({
            event: 'OUTBOX_PUBLISH_UNAUTHORIZED_OR_EXPIRED',
            dispatcherId: this.dispatcherId,
            eventId: event.id
          }, `Could not mark event ${event.id} as PUBLISHED: lease expired or claimed by another dispatcher.`);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error({
          event: 'OUTBOX_EVENT_DISPATCH_FAILED',
          dispatcherId: this.dispatcherId,
          eventId: event.id,
          err: errMsg
        }, `Failed to dispatch outbox event ${event.id}.`);

        try {
          await this.outboxRepo.failEvent(event.id, this.dispatcherId, errMsg);
        } catch (failErr) {
          logger.error({
            event: 'OUTBOX_FAIL_UPDATE_ERROR',
            dispatcherId: this.dispatcherId,
            eventId: event.id,
            err: (failErr as Error).message
          }, `Could not record failure status for event ${event.id}.`);
        }
        failedCount++;
      }
    }

    return {
      claimed: claimedEvents.length,
      published: publishedCount,
      failed: failedCount
    };
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    const poll = async () => {
      if (!this.isRunning) return;
      try {
        await this.dispatchOnce();
      } catch (err) {
        logger.error({ err: (err as Error).message }, 'Unhandled error in outbox polling cycle');
      } finally {
        if (this.isRunning) {
          this.timer = setTimeout(poll, this.pollIntervalMs);
        }
      }
    };

    this.timer = setTimeout(poll, 0);
    logger.info({ dispatcherId: this.dispatcherId }, 'Outbox dispatcher started.');
  }

  public async stop(): Promise<void> {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info({ dispatcherId: this.dispatcherId }, 'Outbox dispatcher stopped.');
  }
}
