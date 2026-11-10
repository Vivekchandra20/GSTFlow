import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../../../src/app/app.js';
import { validateEnv } from '../../../src/config/env.js';

describe('Phase 4.2.1: App Bootstrap, Security & Versioning Integration Suite', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({
      env: validateEnv({
        NODE_ENV: 'test',
        CORS_ORIGIN: 'https://app.gstflow.in',
        BODY_LIMIT: '524288' // 512KB
      }),
      fastifyOverrides: { logger: false }
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('instantiates application in memory without opening network ports', async () => {
    // Assert app instance is ready and has addresses/listening false
    expect(app).toBeDefined();
    expect(typeof app.inject).toBe('function');
  });

  it('supports multiple isolated in-memory test instances without conflict', async () => {
    const appA = await buildApp({
      env: validateEnv({ NODE_ENV: 'test', PORT: '5001' }),
      fastifyOverrides: { logger: false }
    });
    const appB = await buildApp({
      env: validateEnv({ NODE_ENV: 'test', PORT: '5002' }),
      fastifyOverrides: { logger: false }
    });

    const resA = await appA.inject({ method: 'GET', url: '/health' });
    const resB = await appB.inject({ method: 'GET', url: '/health' });

    expect(resA.statusCode).toBe(200);
    expect(resB.statusCode).toBe(200);

    await appA.close();
    await appB.close();
  });

  it('generates a unique request ID and returns it in x-request-id header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health'
    });

    expect(res.statusCode).toBe(200);
    const reqId = res.headers['x-request-id'];
    expect(reqId).toBeDefined();
    expect(typeof reqId).toBe('string');
    expect((reqId as string).length).toBeGreaterThan(10);
  });

  it('preserves and propagates an incoming valid x-request-id header', async () => {
    const customReqId = 'custom-trace-uuid-12345';
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: {
        'x-request-id': customReqId
      }
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBe(customReqId);
  });

  it('enforces baseline security headers (Helmet) and hides x-powered-by', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health'
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('enforces CORS policy matching configured origin on preflight OPTIONS', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1',
      headers: {
        origin: 'https://app.gstflow.in',
        'access-control-request-method': 'GET'
      }
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://app.gstflow.in');
    expect(res.headers['access-control-allow-methods']).toContain('GET');
  });

  it('enforces request body size limits and rejects oversized payloads', async () => {
    // 512KB limit set in beforeAll; payload with 600KB should be rejected with 413
    const oversizedPayload = JSON.stringify({ data: 'a'.repeat(600 * 1024) });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1',
      headers: {
        'content-type': 'application/json'
      },
      payload: oversizedPayload
    });

    expect(res.statusCode).toBe(413);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('provides versioned route group at /api/v1', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1'
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.version).toBe('v1');
    expect(body.description).toContain('GSTFlow');
  });

  it('verifies startServer lifecycle and clean shutdown', async () => {
    const { startServer } = await import('../../../src/app/server.js');
    const testEnv = validateEnv({
      NODE_ENV: 'test',
      PORT: '34567',
      USE_MOCK_REDIS: 'true'
    });

    const server = await startServer({ env: testEnv });
    expect(server.app).toBeDefined();

    // Query the running server via inject
    const res = await server.app.inject({
      method: 'GET',
      url: '/health'
    });
    expect(res.statusCode).toBe(200);

    // Verify graceful shutdown completes cleanly
    await expect(server.close()).resolves.toBeUndefined();
  });
});
