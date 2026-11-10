import { PrismaClient } from '@prisma/client';
import { FastifyInstance } from 'fastify';
import { getEnvConfig, EnvConfig } from '../config/env.js';
import { buildApp } from './app.js';
import { RedisConnectionManager } from '../infrastructure/queue/redis.connection.js';
import { logger } from '../utils/logger.js';

export interface RunningServer {
  app: FastifyInstance;
  prisma?: PrismaClient;
  close: () => Promise<void>;
}

export interface ServerStartOptions {
  env?: EnvConfig;
  prisma?: PrismaClient;
}

/**
 * Starts the GSTFlow HTTP REST API server.
 */
export async function startServer(options: ServerStartOptions = {}): Promise<RunningServer> {
  const env = options.env || getEnvConfig();

  logger.info({
    event: 'SERVER_BOOTSTRAP_START',
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    host: env.HOST
  }, 'Starting GSTFlow API application bootstrap...');

  // Initialize infrastructure clients for production runtime
  let prisma: PrismaClient | undefined = options.prisma;
  if (!prisma && env.DATABASE_URL) {
    prisma = new PrismaClient({
      datasources: {
        db: { url: env.DATABASE_URL }
      }
    });
    await prisma.$connect();
    logger.info({ event: 'DATABASE_CONNECTED' }, 'Connected to PostgreSQL database.');
  }

  const redis = RedisConnectionManager.getInstance({
    url: env.REDIS_URL,
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD,
    db: env.REDIS_DB,
    useMock: env.USE_MOCK_REDIS
  }).getClient();

  const app = await buildApp({
    env,
    prisma,
    redis
  });

  try {
    const address = await app.listen({
      port: env.PORT,
      host: env.HOST
    });

    logger.info({
      event: 'SERVER_LISTENING',
      address,
      port: env.PORT,
      host: env.HOST,
      environment: env.NODE_ENV
    }, `GSTFlow REST API server successfully listening at ${address}`);
  } catch (err: any) {
    logger.fatal({
      event: 'SERVER_STARTUP_FAILED',
      err: err.message,
      stack: err.stack
    }, 'Failed to start GSTFlow HTTP server');
    if (prisma) {
      await prisma.$disconnect().catch(() => {});
    }
    RedisConnectionManager.resetInstance();
    process.exit(1);
  }

  let isShuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info({
      event: 'SERVER_SHUTDOWN_START',
      signal
    }, `Received ${signal}. Shutting down GSTFlow HTTP server gracefully...`);

    const forceExitTimer = setTimeout(() => {
      logger.error({ event: 'SERVER_SHUTDOWN_TIMEOUT' }, 'Graceful shutdown timed out. Forcing process exit.');
      process.exit(1);
    }, 15000);

    try {
      await app.close();
      logger.info({ event: 'SERVER_CLOSED' }, 'HTTP listener closed.');

      if (prisma) {
        await prisma.$disconnect();
        logger.info({ event: 'DATABASE_DISCONNECTED' }, 'Disconnected from PostgreSQL.');
      }

      RedisConnectionManager.resetInstance();
      logger.info({ event: 'REDIS_DISCONNECTED' }, 'Disconnected from Redis.');

      clearTimeout(forceExitTimer);
      logger.info({ event: 'SERVER_SHUTDOWN_COMPLETE' }, 'Graceful shutdown finished successfully.');
    } catch (err: any) {
      clearTimeout(forceExitTimer);
      logger.error({
        event: 'SERVER_SHUTDOWN_ERROR',
        err: err.message
      }, 'Error during graceful shutdown');
      process.exit(1);
    }
  };

  process.once('SIGINT', () => gracefulShutdown('SIGINT'));
  process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));

  return {
    app,
    prisma,
    close: async () => {
      await app.close();
      if (prisma) await prisma.$disconnect();
      RedisConnectionManager.resetInstance();
    }
  };
}

// Auto-run if executed directly via CLI
const isDirectExecution =
  process.argv[1] &&
  (process.argv[1].endsWith('server.ts') || process.argv[1].endsWith('server.js'));

if (isDirectExecution) {
  startServer().catch((err) => {
    logger.fatal({ err: err.message }, 'Fatal error starting server');
    process.exit(1);
  });
}
