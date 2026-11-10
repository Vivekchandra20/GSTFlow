import { PrismaClient } from '@prisma/client';
import { TenantContext, TransactionScope, ITransactionManager } from '../types.js';
import { runInTenantTransaction, extractPrismaClient } from './tenant-context.js';

/**
 * Production PostgreSQL transaction manager leveraging Prisma connection pooling
 * and transaction-local Row-Level Security (RLS) scoping.
 */
export class PrismaTransactionManager implements ITransactionManager {
  constructor(private readonly prisma: PrismaClient) {}

  public async runInTransaction<T>(
    ctx: TenantContext,
    fn: (scope: TransactionScope) => Promise<T>,
    existingScope?: TransactionScope
  ): Promise<T> {
    const existingTx = extractPrismaClient(existingScope);

    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (tx) => {
        const scope: TransactionScope = {
          organizationId: ctx.organizationId,
          transactionId: existingScope?.transactionId || `tx-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          client: tx
        };
        return await fn(scope);
      },
      existingTx
    );
  }
}
