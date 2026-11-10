import { Prisma, PrismaClient } from '@prisma/client';
import { TenantContext, TenantAuthorizationError, TransactionScope } from '../types.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateTenantContext(ctx: TenantContext): void {
  if (!ctx || !ctx.organizationId || typeof ctx.organizationId !== 'string') {
    throw new TenantAuthorizationError('Tenant context is missing or invalid.');
  }
  if (!UUID_REGEX.test(ctx.organizationId)) {
    throw new TenantAuthorizationError(
      `Tenant organization ID '${ctx.organizationId}' is not a valid UUID.`
    );
  }
}

/**
 * Extracts a Prisma.TransactionClient from either a raw Prisma client or a TransactionScope.
 */
export function extractPrismaClient(
  tx?: Prisma.TransactionClient | TransactionScope
): Prisma.TransactionClient | undefined {
  if (!tx) return undefined;
  if (typeof tx === 'object' && 'client' in tx && tx.client) {
    return tx.client as Prisma.TransactionClient;
  }
  return tx as Prisma.TransactionClient;
}

/**
 * Executes a callback within a transaction-local tenant context.
 *
 * Uses `set_config('app.current_organization_id', $1, true)` inside a dedicated
 * PostgreSQL transaction block (`BEGIN ... COMMIT/ROLLBACK`). Setting `is_local = true`
 * is PostgreSQL's parameterized equivalent of `SET LOCAL`.
 *
 * When the transaction completes, PostgreSQL automatically resets the setting,
 * ensuring zero tenant context leakage into connection pools.
 */
export async function runInTenantTransaction<T>(
  prisma: PrismaClient,
  ctx: TenantContext,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  existingTx?: Prisma.TransactionClient | TransactionScope
): Promise<T> {
  validateTenantContext(ctx);

  const client = extractPrismaClient(existingTx);

  if (client) {
    await client.$executeRaw`SELECT set_config('app.current_organization_id', ${ctx.organizationId}, true)`;
    return await fn(client);
  }

  return await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_organization_id', ${ctx.organizationId}, true)`;
      return await fn(tx);
    },
    { maxWait: 15000, timeout: 60000 }
  );
}
