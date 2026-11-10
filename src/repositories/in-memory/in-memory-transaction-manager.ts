import { TenantContext, TransactionScope, ITransactionManager, TenantAuthorizationError } from '../types.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * In-memory transaction manager for testing and non-database workflows.
 * Enforces tenant validation without opening database connections.
 */
export class InMemoryTransactionManager implements ITransactionManager {
  public async runInTransaction<T>(
    ctx: TenantContext,
    fn: (scope: TransactionScope) => Promise<T>,
    existingScope?: TransactionScope
  ): Promise<T> {
    if (!ctx || !ctx.organizationId || !UUID_REGEX.test(ctx.organizationId)) {
      throw new TenantAuthorizationError(`Tenant context is missing or invalid: ${ctx?.organizationId}`);
    }

    const scope: TransactionScope = existingScope || {
      organizationId: ctx.organizationId,
      transactionId: `mem-tx-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      client: null
    };

    return await fn(scope);
  }
}
