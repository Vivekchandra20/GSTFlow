import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../../../src/app/app.js';
import { InMemoryAuthRepository } from '../../../src/modules/auth/in-memory-auth.repository.js';
import { validateEnv } from '../../../src/config/env.js';

describe('Phase 4.2.2: Auth Routes HTTP Integration Suite (/api/v1/auth/*)', () => {
  let app: FastifyInstance;
  let authRepository: InMemoryAuthRepository;

  beforeAll(async () => {
    authRepository = new InMemoryAuthRepository();
    app = await buildApp({
      env: validateEnv({
        NODE_ENV: 'test',
        JWT_ACCESS_SECRET: 'test-secret-at-least-32-chars-for-testing!',
        COOKIE_SECRET: 'cookie-secret-at-least-32-characters-key!'
      }),
      authRepository,
      fastifyOverrides: { logger: false }
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /api/v1/auth/register', () => {
    it('successfully registers a user with status 201 and returns tokens and safe user', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'taxpayer@example.com',
          password: 'Password123'
        }
      });

      expect(response.statusCode).toBe(201);
      const json = response.json();
      expect(json.success).toBe(true);
      expect(json.data.user.email).toBe('taxpayer@example.com');
      expect(json.data.user.status).toBe('ACTIVE');
      expect(json.data.tokens.accessToken).toBeDefined();
      expect(json.data.tokens.refreshToken).toBeDefined();
      expect(json.data.tokens.tokenType).toBe('Bearer');

      // Verify Set-Cookie header contains refreshToken
      const setCookie = response.headers['set-cookie'];
      expect(setCookie).toBeDefined();
      expect(String(setCookie)).toContain('refreshToken=');
      expect(String(setCookie)).toContain('HttpOnly');
    });

    it('rejects duplicate registration with status 409 EMAIL_ALREADY_EXISTS', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'TAXPAYER@example.com',
          password: 'AnotherPassword123'
        }
      });

      expect(response.statusCode).toBe(409);
      const json = response.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('EMAIL_ALREADY_EXISTS');
    });

    it('rejects password failing complexity requirements with status 400 VALIDATION_ERROR', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'weak@example.com',
          password: 'weak' // Too short, missing number and uppercase
        }
      });

      expect(response.statusCode).toBe(400);
      const json = response.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /api/v1/auth/login', () => {
    it('successfully logs in an existing user with status 200', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'taxpayer@example.com',
          password: 'Password123'
        }
      });

      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.success).toBe(true);
      expect(json.data.tokens.accessToken).toBeDefined();
      expect(json.data.tokens.refreshToken).toBeDefined();
    });

    it('rejects login with invalid password with status 401 INVALID_CREDENTIALS', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'taxpayer@example.com',
          password: 'WrongPassword999'
        }
      });

      expect(response.statusCode).toBe(401);
      const json = response.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('rejects login with unknown email with status 401 INVALID_CREDENTIALS', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'nonexistent@example.com',
          password: 'Password123'
        }
      });

      expect(response.statusCode).toBe(401);
      const json = response.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('rejects login for disabled accounts with status 403 ACCOUNT_DISABLED', async () => {
      // Register and disable user
      const regRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'locked@example.com',
          password: 'Password123'
        }
      });
      const userId = regRes.json().data.user.id;
      await authRepository.updateUserStatus(userId, 'DISABLED');

      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'locked@example.com',
          password: 'Password123'
        }
      });

      expect(loginRes.statusCode).toBe(403);
      const json = loginRes.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('ACCOUNT_DISABLED');
    });
  });

  describe('POST /api/v1/auth/refresh', () => {
    it('rotates refresh token and issues new tokens', async () => {
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'taxpayer@example.com',
          password: 'Password123'
        }
      });
      const initialRefreshToken = loginRes.json().data.tokens.refreshToken;

      const refreshRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: {
          refreshToken: initialRefreshToken
        }
      });

      expect(refreshRes.statusCode).toBe(200);
      const json = refreshRes.json();
      expect(json.success).toBe(true);
      expect(json.data.tokens.refreshToken).toBeDefined();
      expect(json.data.tokens.refreshToken).not.toBe(initialRefreshToken);
    });

    it('detects refresh token reuse and returns 401 REFRESH_TOKEN_REUSED', async () => {
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'taxpayer@example.com',
          password: 'Password123'
        }
      });
      const token = loginRes.json().data.tokens.refreshToken;

      // Rotate token once
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: { refreshToken: token }
      });

      // Attempt to reuse already rotated token
      const reuseRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: { refreshToken: token }
      });

      expect(reuseRes.statusCode).toBe(401);
      const json = reuseRes.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('REFRESH_TOKEN_REUSED');
    });

    it('rejects refresh when no token is provided with 401 INVALID_REFRESH_TOKEN', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: {}
      });

      expect(res.statusCode).toBe(401);
      const json = res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('INVALID_REFRESH_TOKEN');
    });
  });

  describe('POST /api/v1/auth/logout', () => {
    it('revokes refresh token and clears cookie with status 200', async () => {
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'taxpayer@example.com',
          password: 'Password123'
        }
      });
      const token = loginRes.json().data.tokens.refreshToken;

      const logoutRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        payload: { refreshToken: token }
      });

      expect(logoutRes.statusCode).toBe(200);
      const json = logoutRes.json();
      expect(json.success).toBe(true);

      const setCookie = logoutRes.headers['set-cookie'];
      expect(setCookie).toBeDefined();
    });
  });

  describe('GET /api/v1/auth/me (Protected)', () => {
    it('returns safe user details when a valid Bearer token is provided', async () => {
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'taxpayer@example.com',
          password: 'Password123'
        }
      });
      const accessToken = loginRes.json().data.tokens.accessToken;

      const meRes = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: {
          authorization: `Bearer ${accessToken}`
        }
      });

      expect(meRes.statusCode).toBe(200);
      const json = meRes.json();
      expect(json.success).toBe(true);
      expect(json.data.user.email).toBe('taxpayer@example.com');
      expect(json.data.user.status).toBe('ACTIVE');
      expect((json.data.user as any).passwordHash).toBeUndefined();
    });

    it('rejects requests without Authorization header with status 401 UNAUTHENTICATED', async () => {
      const meRes = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me'
      });

      expect(meRes.statusCode).toBe(401);
      const json = meRes.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('UNAUTHENTICATED');
    });

    it('rejects requests with malformed Authorization header with status 401 UNAUTHENTICATED', async () => {
      const meRes = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: {
          authorization: 'Basic dXNlcm5hbWU6cGFzc3dvcmQ='
        }
      });

      expect(meRes.statusCode).toBe(401);
      const json = meRes.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('UNAUTHENTICATED');
    });

    it('rejects requests with invalid token with status 401 INVALID_ACCESS_TOKEN', async () => {
      const meRes = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: {
          authorization: 'Bearer invalid.jwt.token'
        }
      });

      expect(meRes.statusCode).toBe(401);
      const json = meRes.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('INVALID_ACCESS_TOKEN');
    });
  });
});
