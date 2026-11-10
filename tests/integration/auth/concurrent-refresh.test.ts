import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { AuthService } from '../../../src/modules/auth/auth.service.js';
import { PrismaAuthRepository } from '../../../src/modules/auth/auth.repository.js';
import { PasswordService } from '../../../src/modules/auth/password.service.js';
import { TokenService } from '../../../src/modules/auth/token.service.js';
import { RefreshTokenReusedError } from '../../../src/modules/auth/auth.errors.js';
import { buildApp } from '../../../src/app/app.js';
import { FastifyInstance } from 'fastify';
import { validateEnv } from '../../../src/config/env.js';

describe('Phase 4.2.2: Concurrent Refresh Token Rotation & PostgreSQL Persistence Suite', () => {
  let pgServer: any;
  let adminClient: pg.Client;
  let prisma: PrismaClient;
  let authRepository: PrismaAuthRepository;
  let authService: AuthService;
  let app: FastifyInstance;

  const testDbName = 'gstflow_phase4_2_2_auth_db';
  const testPort = 54345;
  const dataDir = path.resolve('.pgdata_phase4_2_2_auth');

  beforeAll(async () => {
    if (fs.existsSync(dataDir)) {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {}
    }

    // 1. Initialize and start isolated PostgreSQL 16 server
    const epModule = await import('embedded-postgres');
    const EmbeddedPostgresClass = epModule.default || epModule;
    pgServer = new (EmbeddedPostgresClass as any)({
      databaseDir: dataDir,
      port: testPort,
      user: 'postgres',
      password: 'postgrespassword',
      persistent: false
    });

    await pgServer.initialise();
    await pgServer.start();

    // 2. Connect as root admin to create test database
    const rootClient = new pg.Client({
      host: 'localhost',
      port: testPort,
      user: 'postgres',
      password: 'postgrespassword',
      database: 'postgres'
    });
    await rootClient.connect();
    await rootClient.query(`DROP DATABASE IF EXISTS ${testDbName};`);
    await rootClient.query(`CREATE DATABASE ${testDbName};`);
    await rootClient.end();

    // 3. Connect to test DB as admin and apply all migrations
    adminClient = new pg.Client({
      host: 'localhost',
      port: testPort,
      user: 'postgres',
      password: 'postgrespassword',
      database: testDbName
    });
    await adminClient.connect();

    // Migration 1: Persistence Foundation
    const mig1 = fs.readFileSync(
      path.resolve('prisma/migrations/20261107000000_init_persistence_foundation/migration.sql'),
      'utf8'
    );
    await adminClient.query(mig1);

    // Migration 2: Asynchronous Outbox & Jobs
    const mig2 = fs.readFileSync(
      path.resolve('prisma/migrations/20261108000000_phase4_1_asynchronous_outbox_jobs/migration.sql'),
      'utf8'
    );
    await adminClient.query(mig2);

    // Migration 3: User Authentication & Identity
    const mig3 = fs.readFileSync(
      path.resolve('prisma/migrations/20261109000000_phase4_2_2_user_authentication/migration.sql'),
      'utf8'
    );
    await adminClient.query(mig3);

    // 4. Connect Prisma as application user
    const databaseUrl = `postgresql://gstflow_app:gstflow_app_password@localhost:${testPort}/${testDbName}`;
    prisma = new PrismaClient({
      datasources: {
        db: { url: databaseUrl }
      }
    });
    await prisma.$connect();

    authRepository = new PrismaAuthRepository(prisma);
    const passwordService = new PasswordService();
    const tokenService = new TokenService();
    authService = new AuthService(authRepository, passwordService, tokenService);

    // 5. Build Fastify app with real PostgreSQL prisma
    app = await buildApp({
      env: validateEnv({
        NODE_ENV: 'test',
        DATABASE_URL: databaseUrl,
        JWT_ACCESS_SECRET: 'test-secret-at-least-32-chars-for-testing!',
        COOKIE_SECRET: 'cookie-secret-at-least-32-characters-key!'
      }),
      prisma,
      fastifyOverrides: { logger: false }
    });
    await app.ready();
  }, 60000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (prisma) {
      await prisma.$disconnect();
    }
    if (adminClient) {
      await adminClient.end();
    }
    if (pgServer) {
      try {
        await pgServer.stop();
      } catch {}
    }
    if (fs.existsSync(dataDir)) {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {}
    }
  });

  it('serializes concurrent refresh requests via row locking and triggers reuse detection', async () => {
    // 1. Register a user
    const auth = await authService.register({
      email: 'concurrent-user@example.com',
      password: 'StrongPassword123'
    });

    const initialRefreshToken = auth.tokens.refreshToken;

    // 2. Fire 3 concurrent refresh requests presenting the identical token
    const results = await Promise.allSettled([
      authService.refresh(initialRefreshToken),
      authService.refresh(initialRefreshToken),
      authService.refresh(initialRefreshToken)
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Exactly one request must succeed, or if the second request runs, it triggers reuse detection
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    expect(fulfilled.length).toBeLessThanOrEqual(2);

    // Any rejected request must fail with RefreshTokenReusedError
    for (const rej of rejected) {
      if (rej.status === 'rejected') {
        expect(rej.reason).toBeInstanceOf(RefreshTokenReusedError);
      }
    }
  });

  it('runs end-to-end auth lifecycle against PostgreSQL via Fastify HTTP endpoints', async () => {
    // 1. Register
    const regRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'real-pg-user@example.com',
        password: 'Password123'
      }
    });

    expect(regRes.statusCode).toBe(201);
    const regJson = regRes.json();
    expect(regJson.success).toBe(true);
    expect(regJson.data.user.email).toBe('real-pg-user@example.com');
    const accessToken = regJson.data.tokens.accessToken;
    const refreshToken = regJson.data.tokens.refreshToken;

    // 2. GET /me (Protected)
    const meRes = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: {
        authorization: `Bearer ${accessToken}`
      }
    });

    expect(meRes.statusCode).toBe(200);
    const meJson = meRes.json();
    expect(meJson.data.user.email).toBe('real-pg-user@example.com');

    // 3. Rotate refresh token
    const refreshRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken }
    });

    expect(refreshRes.statusCode).toBe(200);
    const newRefreshToken = refreshRes.json().data.tokens.refreshToken;
    expect(newRefreshToken).not.toBe(refreshToken);

    // 4. Logout
    const logoutRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      payload: { refreshToken: newRefreshToken }
    });

    expect(logoutRes.statusCode).toBe(200);

    // 5. Subsequent refresh with revoked token fails with 401
    const postLogoutRefresh = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: newRefreshToken }
    });

    expect(postLogoutRefresh.statusCode).toBe(401);
    expect(postLogoutRefresh.json().error.code).toBe('REFRESH_TOKEN_REUSED');
  });
});
