import { PrismaClient } from '@prisma/client';
import {
  TenantContext,
  TransactionClient,
  IOutboxRepository,
  OutboxEventEntity,
  CreateOutboxEventInput,
  ClaimedOutboxEvent,
  OutboxStatus
} from '../types.js';
import { runInTenantTransaction } from './tenant-context.js';

export class PrismaOutboxRepository implements IOutboxRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public async createOutboxEvent(
    ctx: TenantContext,
    input: CreateOutboxEventInput,
    tx?: TransactionClient
  ): Promise<OutboxEventEntity> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const created = await (client as any).outboxEvent.create({
          data: {
            organizationId: ctx.organizationId,
            eventType: input.eventType,
            payload: input.payload as any,
            status: OutboxStatus.PENDING,
            attempts: 0
          }
        });

        return {
          id: created.id,
          organizationId: created.organizationId,
          eventType: created.eventType,
          payload: created.payload,
          status: created.status as OutboxStatus,
          claimedBy: created.claimedBy,
          leaseExpiresAt: created.leaseExpiresAt,
          publishedAt: created.publishedAt,
          attempts: created.attempts,
          lastError: created.lastError,
          createdAt: created.createdAt,
          updatedAt: created.updatedAt
        };
      },
      tx
    );
  }

  public async claimEvents(
    claimedBy: string,
    batchSize: number,
    leaseSeconds: number
  ): Promise<ClaimedOutboxEvent[]> {
    // Atomically claim events via restricted SECURITY DEFINER function
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        organization_id: string;
        event_type: string;
        payload: any;
        attempts: number;
      }>
    >(
      `SELECT id, organization_id, event_type, payload, attempts 
       FROM claim_outbox_events($1::text, $2::integer, $3::integer);`,
      claimedBy,
      batchSize,
      leaseSeconds
    );

    return rows.map((r) => ({
      id: r.id,
      organizationId: r.organization_id,
      eventType: r.event_type,
      payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
      attempts: r.attempts
    }));
  }

  public async markPublished(eventId: string, claimedBy: string): Promise<boolean> {
    const result = await this.prisma.$queryRawUnsafe<Array<{ mark_outbox_published: boolean }>>(
      `SELECT mark_outbox_published($1::uuid, $2::text);`,
      eventId,
      claimedBy
    );
    return result[0]?.mark_outbox_published ?? false;
  }

  public async failEvent(
    eventId: string,
    claimedBy: string,
    error: string,
    maxAttempts: number = 5
  ): Promise<boolean> {
    const result = await this.prisma.$queryRawUnsafe<Array<{ fail_outbox_event: boolean }>>(
      `SELECT fail_outbox_event($1::uuid, $2::text, $3::text, $4::integer);`,
      eventId,
      claimedBy,
      error,
      maxAttempts
    );
    return result[0]?.fail_outbox_event ?? false;
  }

  public async findById(
    ctx: TenantContext,
    eventId: string,
    tx?: TransactionClient
  ): Promise<OutboxEventEntity | null> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const found = await (client as any).outboxEvent.findFirst({
          where: {
            id: eventId,
            organizationId: ctx.organizationId
          }
        });

        if (!found) return null;

        return {
          id: found.id,
          organizationId: found.organizationId,
          eventType: found.eventType,
          payload: found.payload,
          status: found.status as OutboxStatus,
          claimedBy: found.claimedBy,
          leaseExpiresAt: found.leaseExpiresAt,
          publishedAt: found.publishedAt,
          attempts: found.attempts,
          lastError: found.lastError,
          createdAt: found.createdAt,
          updatedAt: found.updatedAt
        };
      },
      tx
    );
  }
}
