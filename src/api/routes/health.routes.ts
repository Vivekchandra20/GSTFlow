import { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { RedisConnectionManager } from '../../infrastructure/queue/redis.connection.js';

export interface HealthCheckOptions {
  prisma?: PrismaClient;
  redis?: Redis;
  timeoutMs?: number;
}

/**
 * Executes an async check function with a strict timeout boundary.
 */
async function checkWithTimeout(
  checkFn: () => Promise<boolean>,
  timeoutMs: number
): Promise<boolean> {
  let timer: NodeJS.Timeout | null = null;
  try {
    const timeoutPromise = new Promise<boolean>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Check timed out')), timeoutMs);
    });

    const result = await Promise.race([checkFn(), timeoutPromise]);
    return result === true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createHealthRoutes(options: HealthCheckOptions = {}): FastifyPluginAsync {
  return async (fastify: FastifyInstance) => {
    const timeoutMs = options.timeoutMs ?? 2000;

    // 1. Liveness Probe: GET /health
    fastify.get('/health', async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.status(200).send({
        success: true,
        status: 'alive',
        timestamp: new Date().toISOString()
      });
    });

    // 2. Readiness Probe: GET /health/ready
    fastify.get('/health/ready', async (_request: FastifyRequest, reply: FastifyReply) => {
      // Check PostgreSQL
      const checkDatabase = async (): Promise<boolean> => {
        try {
          const prisma = options.prisma || (fastify as any).prisma;
          if (!prisma) {
            return false;
          }
          await prisma.$queryRawUnsafe('SELECT 1');
          return true;
        } catch {
          return false;
        }
      };

      // Check Redis
      const checkRedis = async (): Promise<boolean> => {
        try {
          const redis = options.redis || (fastify as any).redis || RedisConnectionManager.getInstance().getClient();
          if (!redis) {
            return false;
          }
          const pong = await redis.ping();
          return pong === 'PONG' || pong === 'OK';
        } catch {
          return false;
        }
      };

      // Execute checks concurrently under strict timeout
      const [dbOk, redisOk] = await Promise.all([
        checkWithTimeout(checkDatabase, timeoutMs),
        checkWithTimeout(checkRedis, timeoutMs)
      ]);

      const isReady = dbOk && redisOk;
      const statusCode = isReady ? 200 : 503;

      return reply.status(statusCode).send({
        success: isReady,
        status: isReady ? 'ready' : 'not_ready',
        dependencies: {
          database: dbOk ? 'connected' : 'unavailable',
          redis: redisOk ? 'connected' : 'unavailable'
        },
        timestamp: new Date().toISOString()
      });
    });
  };
}
