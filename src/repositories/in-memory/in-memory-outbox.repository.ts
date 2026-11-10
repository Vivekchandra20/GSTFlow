import crypto from 'crypto';
import {
  TenantContext,
  TransactionClient,
  IOutboxRepository,
  OutboxEventEntity,
  CreateOutboxEventInput,
  ClaimedOutboxEvent,
  OutboxStatus
} from '../types.js';

export class InMemoryOutboxRepository implements IOutboxRepository {
  private events: OutboxEventEntity[] = [];

  public async createOutboxEvent(
    ctx: TenantContext,
    input: CreateOutboxEventInput,
    _tx?: TransactionClient
  ): Promise<OutboxEventEntity> {
    const event: OutboxEventEntity = {
      id: crypto.randomUUID(),
      organizationId: ctx.organizationId,
      eventType: input.eventType,
      payload: input.payload,
      status: OutboxStatus.PENDING,
      claimedBy: null,
      leaseExpiresAt: null,
      publishedAt: null,
      attempts: 0,
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    this.events.push(event);
    return { ...event };
  }

  public async claimEvents(
    claimedBy: string,
    batchSize: number,
    leaseSeconds: number
  ): Promise<ClaimedOutboxEvent[]> {
    const now = new Date();
    const eligible = this.events.filter(
      (e) =>
        e.status === OutboxStatus.PENDING ||
        (e.status === OutboxStatus.CLAIMED && e.leaseExpiresAt !== null && e.leaseExpiresAt < now)
    ).slice(0, batchSize);

    const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000);
    const claimed: ClaimedOutboxEvent[] = [];

    for (const e of eligible) {
      e.status = OutboxStatus.CLAIMED;
      e.claimedBy = claimedBy;
      e.leaseExpiresAt = leaseExpiresAt;
      e.attempts += 1;
      e.updatedAt = new Date();
      claimed.push({
        id: e.id,
        organizationId: e.organizationId,
        eventType: e.eventType,
        payload: e.payload,
        attempts: e.attempts
      });
    }

    return claimed;
  }

  public async markPublished(eventId: string, claimedBy: string): Promise<boolean> {
    const e = this.events.find((ev) => ev.id === eventId);
    if (!e) return false;
    const now = new Date();
    if (e.status !== OutboxStatus.CLAIMED) return false;
    if (claimedBy && e.claimedBy !== claimedBy) return false;
    if (e.leaseExpiresAt && e.leaseExpiresAt < now) return false;

    e.status = OutboxStatus.PUBLISHED;
    e.publishedAt = now;
    e.leaseExpiresAt = null;
    e.updatedAt = now;
    return true;
  }

  public async failEvent(
    eventId: string,
    claimedBy: string,
    error: string,
    maxAttempts: number = 5
  ): Promise<boolean> {
    const e = this.events.find((ev) => ev.id === eventId);
    if (!e) return false;
    const now = new Date();
    if (e.status !== OutboxStatus.CLAIMED) return false;
    if (claimedBy && e.claimedBy !== claimedBy) return false;
    if (e.leaseExpiresAt && e.leaseExpiresAt < now) return false;

    e.status = e.attempts >= maxAttempts ? OutboxStatus.FAILED : OutboxStatus.PENDING;
    e.leaseExpiresAt = null;
    e.claimedBy = null;
    e.lastError = error ? error.substring(0, 4096) : 'Unknown error';
    e.updatedAt = now;
    return true;
  }

  public async findById(
    ctx: TenantContext,
    eventId: string,
    _tx?: TransactionClient
  ): Promise<OutboxEventEntity | null> {
    const e = this.events.find((ev) => ev.id === eventId && ev.organizationId === ctx.organizationId);
    return e ? { ...e } : null;
  }

  public clear(): void {
    this.events = [];
  }
}
