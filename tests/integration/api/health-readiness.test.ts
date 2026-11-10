import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../../../src/app/app.js';
import { validateEnv } from '../../../src/config/env.js';

describe('Phase 4.2.1: Health & Readiness Integration Suite', () => {
  it('GET /health: liveness probe succeeds with 200 without database or redis availability', async () => {
    // App with no prisma and no redis attached
    const app = await buildApp({
      env: validateEnv({ NODE_ENV: 'test' }),
      fastifyOverrides: { logger: false }
    });

    const res = await app.inject({
      method: 'GET',
      url: '/health'
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.status).toBe('alive');
    expect(body.timestamp).toBeDefined();
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);

    await app.close();
  });

  it('GET /health/ready: returns 200 ready when database and redis checks pass', async () => {
    const mockPrisma = {
      $queryRawUnsafe: async (_sql: string) => [{ result: 1 }]
    } as any;

    const mockRedis = {
      ping: async () => 'PONG'
    } as any;

    const app = await buildApp({
      env: validateEnv({ NODE_ENV: 'test' }),
      prisma: mockPrisma,
      redis: mockRedis,
      fastifyOverrides: { logger: false }
    });

    const res = await app.inject({
      method: 'GET',
      url: '/health/ready'
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.status).toBe('ready');
    expect(body.dependencies.database).toBe('connected');
    expect(body.dependencies.redis).toBe('connected');
    expect(body.timestamp).toBeDefined();

    await app.close();
  });

  it('GET /health/ready: returns 503 not_ready when database is unavailable', async () => {
    const failingPrisma = {
      $queryRawUnsafe: async () => {
        throw new Error('Connection refused to PostgreSQL host');
      }
    } as any;

    const mockRedis = {
      ping: async () => 'PONG'
    } as any;

    const app = await buildApp({
      env: validateEnv({ NODE_ENV: 'test' }),
      prisma: failingPrisma,
      redis: mockRedis,
      fastifyOverrides: { logger: false }
    });

    const res = await app.inject({
      method: 'GET',
      url: '/health/ready'
    });

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.status).toBe('not_ready');
    expect(body.dependencies.database).toBe('unavailable');
    expect(body.dependencies.redis).toBe('connected');

    await app.close();
  });

  it('GET /health/ready: returns 503 not_ready when redis is unavailable', async () => {
    const mockPrisma = {
      $queryRawUnsafe: async () => [{ result: 1 }]
    } as any;

    const failingRedis = {
      ping: async () => {
        throw new Error('Redis connection closed');
      }
    } as any;

    const app = await buildApp({
      env: validateEnv({ NODE_ENV: 'test' }),
      prisma: mockPrisma,
      redis: failingRedis,
      fastifyOverrides: { logger: false }
    });

    const res = await app.inject({
      method: 'GET',
      url: '/health/ready'
    });

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.status).toBe('not_ready');
    expect(body.dependencies.database).toBe('connected');
    expect(body.dependencies.redis).toBe('unavailable');

    await app.close();
  });

  it('GET /health/ready: returns 503 when dependency check exceeds timeoutMs', async () => {
    // Hanging database check
    const hangingPrisma = {
      $queryRawUnsafe: async () => {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        return [{ result: 1 }];
      }
    } as any;

    const mockRedis = {
      ping: async () => 'PONG'
    } as any;

    const app = await buildApp({
      env: validateEnv({
        NODE_ENV: 'test',
        HEALTH_CHECK_TIMEOUT_MS: '200' // Short 200ms timeout
      }),
      prisma: hangingPrisma,
      redis: mockRedis,
      fastifyOverrides: { logger: false }
    });

    const startTime = Date.now();
    const res = await app.inject({
      method: 'GET',
      url: '/health/ready'
    });
    const duration = Date.now() - startTime;

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.status).toBe('not_ready');
    expect(body.dependencies.database).toBe('unavailable');
    expect(body.dependencies.redis).toBe('connected');
    // Ensure timeout cut off execution promptly
    expect(duration).toBeLessThan(1500);

    await app.close();
  });

  it('GET /health/ready: integrates seamlessly with RedisConnectionManager mock client', async () => {
    const { RedisConnectionManager } = await import('../../../src/infrastructure/queue/redis.connection.js');
    const redis = RedisConnectionManager.getInstance({ useMock: true }).getClient();
    const mockPrisma = {
      $queryRawUnsafe: async () => [{ result: 1 }]
    } as any;

    const app = await buildApp({
      env: validateEnv({ NODE_ENV: 'test', USE_MOCK_REDIS: 'true' }),
      prisma: mockPrisma,
      redis,
      fastifyOverrides: { logger: false }
    });

    const res = await app.inject({
      method: 'GET',
      url: '/health/ready'
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.dependencies.redis).toBe('connected');

    await app.close();
  });
});
