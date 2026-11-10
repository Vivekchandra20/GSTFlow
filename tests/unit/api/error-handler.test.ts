import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { z } from 'zod';
import errorHandlerPlugin from '../../../src/api/plugins/error-handler.js';
import validationPlugin from '../../../src/api/plugins/validation.js';
import requestContextPlugin from '../../../src/api/plugins/request-context.js';
import { TenantAuthorizationError } from '../../../src/repositories/types.js';

describe('Phase 4.2.1: Error Handler Plugin Unit Tests', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ bodyLimit: 1024 }); // Small 1KB limit for testing 413

    await app.register(requestContextPlugin);
    await app.register(validationPlugin);
    await app.register(errorHandlerPlugin);

    // Test route with Zod body schema
    app.post(
      '/test/validation',
      {
        schema: {
          body: z.object({
            name: z.string().min(3),
            amount: z.number().positive()
          })
        }
      },
      async (req, reply) => {
        return reply.status(200).send({ success: true, data: req.body });
      }
    );

    // Test route throwing TenantAuthorizationError
    app.get('/test/tenant-error', async () => {
      throw new TenantAuthorizationError('Organization org-123 is unauthorized');
    });

    // Test route throwing unhandled Error
    app.get('/test/internal-error', async () => {
      throw new Error('Database connection failed: SELECT * FROM secrets WHERE key="abc"');
    });

    // Test route throwing explicit 404
    app.get('/test/not-found', async (_req, reply) => {
      return reply.status(404).send({ success: false, message: 'Item not found' });
    });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('formats Zod validation errors into standard 400 envelope', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test/validation',
      headers: { 'content-type': 'application/json' },
      payload: {
        name: 'ab', // < 3 characters
        amount: -50 // not positive
      }
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBe('Request validation failed');
    expect(Array.isArray(body.error.details)).toBe(true);
    expect(body.error.details.length).toBeGreaterThanOrEqual(2);
    expect(body.requestId).toBeDefined();
  });

  it('handles malformed JSON payload with 400 MALFORMED_REQUEST', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test/validation',
      headers: { 'content-type': 'application/json' },
      payload: '{"name": "invalid-json", amount: ' // syntax error
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('MALFORMED_REQUEST');
    expect(body.requestId).toBeDefined();
  });

  it('returns 404 NOT_FOUND for unknown routes with request ID', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/non-existent-route'
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toContain('Route GET /api/v1/non-existent-route not found');
    expect(body.requestId).toBeDefined();
  });

  it('maps TenantAuthorizationError to 403 TENANT_AUTHORIZATION_ERROR', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/test/tenant-error'
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('TENANT_AUTHORIZATION_ERROR');
    expect(body.requestId).toBeDefined();
  });

  it('enforces body limit and returns 413 PAYLOAD_TOO_LARGE', async () => {
    const largeString = 'x'.repeat(2048); // 2KB exceeds 1KB limit
    const res = await app.inject({
      method: 'POST',
      url: '/test/validation',
      headers: { 'content-type': 'application/json' },
      payload: { name: largeString, amount: 100 }
    });

    expect(res.statusCode).toBe(413);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(body.requestId).toBeDefined();
  });

  it('masks internal error details in production environment', async () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/test/internal-error'
      });

      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('INTERNAL_SERVER_ERROR');
      // In production, internal error details and SQL strings must NEVER be revealed
      expect(body.error.message).toBe('An unexpected internal server error occurred');
      expect(body.error.details).toBeUndefined();
      expect(body.error.stack).toBeUndefined();
      expect(body.requestId).toBeDefined();
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });
});
