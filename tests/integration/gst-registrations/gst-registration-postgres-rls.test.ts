import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import pg from 'pg';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { FastifyInstance } from 'fastify';
import { PrismaAuthRepository } from '../../../src/modules/auth/auth.repository.js';
import { PrismaOrganizationRepository } from '../../../src/modules/organizations/organization.repository.js';
import { PrismaGstRegistrationRepository } from '../../../src/modules/gst-registrations/gst-registration.repository.js';
import { OrganizationService } from '../../../src/modules/organizations/organization.service.js';
import { GstRegistrationService } from '../../../src/modules/gst-registrations/gst-registration.service.js';
import { buildApp } from '../../../src/app/app.js';
import { TokenService } from '../../../src/modules/auth/token.service.js';
import { validateEnv } from '../../../src/config/env.js';
import { DuplicateGstinRegistrationError } from '../../../src/modules/gst-registrations/gst-registration.errors.js';

describe('Phase 4.2.4: GST Registration, RBAC & PostgreSQL RLS Integration Suite', () => {
  let pgServer: any;
  let adminClient: pg.Client;
  let prisma: PrismaClient;
  let authRepo: PrismaAuthRepository;
  let orgRepo: PrismaOrganizationRepository;
  let gstRepo: PrismaGstRegistrationRepository;
  let orgService: OrganizationService;
  let gstService: GstRegistrationService;
  let app: FastifyInstance;
  let tokenService: TokenService;

  const testDbName = 'gstflow_phase4_2_4_gst_db';
  const testPort = 54347;
  const dataDir = path.resolve('.pgdata_phase4_2_4_gst');

  let userA: any;
  let userB: any;

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET = 'test-secret-at-least-32-chars-for-testing!';
    process.env.COOKIE_SECRET = 'cookie-secret-at-least-32-characters-key!';
    process.env.JWT_ISSUER = 'gstflow-api';
    process.env.JWT_AUDIENCE = 'gstflow-client';

    if (fs.existsSync(dataDir)) {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {}
    }

    // 1. Initialize isolated PostgreSQL 16
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

    // 3. Connect to test DB as admin and apply all 5 migrations
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

    // Migration 4: Organization Management & RBAC
    const mig4 = fs.readFileSync(
      path.resolve('prisma/migrations/20261109010000_phase4_2_3_organization_membership_rbac/migration.sql'),
      'utf8'
    );
    await adminClient.query(mig4);

    // Migration 5: GST Registration Lifecycle (Phase 4.2.4)
    const mig5 = fs.readFileSync(
      path.resolve('prisma/migrations/20261109020000_phase4_2_4_gst_registration_lifecycle/migration.sql'),
      'utf8'
    );
    await adminClient.query(mig5);

    // Migration 7: Invitation Discovery & Resolution Functions
    const mig7 = fs.readFileSync(
      path.resolve('prisma/migrations/20261109040000_phase4_2_6_invitation_discovery_functions/migration.sql'),
      'utf8'
    );
    await adminClient.query(mig7);

    // 4. Connect Prisma as application user (gstflow_app)
    const databaseUrl = `postgresql://gstflow_app:gstflow_app_password@localhost:${testPort}/${testDbName}`;
    prisma = new PrismaClient({
      datasources: {
        db: { url: databaseUrl }
      }
    });
    await prisma.$connect();

    authRepo = new PrismaAuthRepository(prisma);
    orgRepo = new PrismaOrganizationRepository(prisma);
    gstRepo = new PrismaGstRegistrationRepository(prisma);

    orgService = new OrganizationService(orgRepo);
    gstService = new GstRegistrationService(gstRepo);
    tokenService = new TokenService();

    // 5. Seed test users
    userA = await authRepo.createUser({
      email: 'usera@example.com',
      normalizedEmail: 'usera@example.com',
      passwordHash: 'dummy'
    });
    userB = await authRepo.createUser({
      email: 'userb@example.com',
      normalizedEmail: 'userb@example.com',
      passwordHash: 'dummy'
    });

    // 6. Build Fastify HTTP application backed by PostgreSQL
    app = await buildApp({
      env: validateEnv({
        NODE_ENV: 'test',
        JWT_ACCESS_SECRET: 'test-secret-at-least-32-chars-for-testing!',
        COOKIE_SECRET: 'cookie-secret-at-least-32-characters-key!'
      }),
      prisma,
      authRepository: authRepo,
      organizationRepository: orgRepo,
      gstRegistrationRepository: gstRepo,
      fastifyOverrides: { logger: false }
    });
    await app.ready();
  }, 60000);

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) await prisma.$disconnect();
    if (adminClient) await adminClient.end();
    if (pgServer) {
      try {
        await pgServer.stop();
      } catch {}
    }
  });

  it('strictly isolates GST registrations between organizations via PostgreSQL Row-Level Security', async () => {
    // 1. Create Org Alpha (owned by userA)
    const orgAlpha = await orgService.createOrganization(userA.id, {
      name: 'Alpha Industries Pvt Ltd',
      pan: 'AAPFU0939F'
    });
    const orgAlphaId = orgAlpha.organization.id;

    // 2. Create Org Beta (owned by userB)
    const orgBeta = await orgService.createOrganization(userB.id, {
      name: 'Beta Global Pvt Ltd',
      pan: 'AABCU9603R'
    });
    const orgBetaId = orgBeta.organization.id;

    // 3. Register GSTIN in Org Alpha (Maharashtra)
    const regAlpha = await gstService.createRegistration(orgAlphaId, {
      gstin: '27AAPFU0939F1ZV',
      legalName: 'Alpha Maharashtra Unit'
    });

    // 4. Register GSTIN in Org Beta (Karnataka)
    const regBeta = await gstService.createRegistration(orgBetaId, {
      gstin: '29AABCU9603R1ZJ',
      legalName: 'Beta Karnataka Unit'
    });

    // 5. Query under Org Alpha tenant transaction: only Alpha's registration is visible
    await gstRepo.runInTenantTransaction(orgAlphaId, async (tx) => {
      const rows = await tx.$queryRaw<any[]>`SELECT * FROM gst_registrations;`;
      expect(rows.length).toBe(1);
      expect(rows[0].id).toBe(regAlpha.id);
      expect(rows[0].gstin).toBe('27AAPFU0939F1ZV');
      expect(rows[0].organization_id).toBe(orgAlphaId);

      // Attempting to select Beta's registration directly returns empty (RLS blocked)
      const targetBeta = await tx.$queryRaw<any[]>`
        SELECT * FROM gst_registrations WHERE id = ${regBeta.id}::uuid;
      `;
      expect(targetBeta.length).toBe(0);
    });

    // 6. Query under Org Beta tenant transaction: only Beta's registration is visible
    await gstRepo.runInTenantTransaction(orgBetaId, async (tx) => {
      const rows = await tx.$queryRaw<any[]>`SELECT * FROM gst_registrations;`;
      expect(rows.length).toBe(1);
      expect(rows[0].id).toBe(regBeta.id);
      expect(rows[0].gstin).toBe('29AABCU9603R1ZJ');
      expect(rows[0].organization_id).toBe(orgBetaId);
    });
  });

  it('serializes concurrent duplicate GSTIN registration requests via PostgreSQL unique constraint', async () => {
    const orgRes = await orgService.createOrganization(userA.id, {
      name: 'Concurrent Test Corp',
      pan: 'AAACA1234A'
    });
    const orgId = orgRes.organization.id;

    // Fire 2 simultaneous registration requests with identical GSTIN
    const results = await Promise.allSettled([
      gstService.createRegistration(orgId, {
        gstin: '33AAACA1234A1ZR',
        legalName: 'Tamil Nadu Entity - Worker 1'
      }),
      gstService.createRegistration(orgId, {
        gstin: '33AAACA1234A1ZR',
        legalName: 'Tamil Nadu Entity - Worker 2'
      })
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Exactly one succeeds; second rejected with DuplicateGstinRegistrationError
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    if (rejected[0].status === 'rejected') {
      expect(rejected[0].reason instanceof DuplicateGstinRegistrationError).toBe(true);
    }
  });

  it('runs complete GST registration lifecycle via Fastify HTTP endpoints against PostgreSQL 16', async () => {
    // 1. Create organization via HTTP
    const tokenA = tokenService.signAccessToken(userA.id).accessToken;

    const createOrgRes = await app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        name: 'Full Lifecycle PG Org',
        pan: 'AAAAA0000A'
      }
    });

    expect(createOrgRes.statusCode).toBe(201);
    const orgId = createOrgRes.json().data.organization.id;

    // 2. Register GSTIN via POST /organizations/:organizationId/gst-registrations
    const createGstRes = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${orgId}/gst-registrations`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        gstin: '07AAAAA0000A1Z4',
        legalName: 'Delhi HQ',
        tradeName: 'Capital Operations',
        registrationType: 'REGULAR',
        effectiveDate: '2024-04-01'
      }
    });

    expect(createGstRes.statusCode).toBe(201);
    const regId = createGstRes.json().data.gstRegistration.id;
    expect(createGstRes.json().data.gstRegistration.gstin).toBe('07AAAAA0000A1Z4');
    expect(createGstRes.json().data.gstRegistration.stateCode).toBe('07');

    // 3. Retrieve registration via GET /organizations/:organizationId/gst-registrations/:id
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${orgId}/gst-registrations/${regId}`,
      headers: { authorization: `Bearer ${tokenA}` }
    });

    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().data.gstRegistration.legalName).toBe('Delhi HQ');

    // 4. Update registration details via PATCH
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/organizations/${orgId}/gst-registrations/${regId}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        tradeName: 'Capital Mega Hub'
      }
    });

    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().data.gstRegistration.tradeName).toBe('Capital Mega Hub');

    // 5. Suspend registration via PATCH .../status
    const suspendRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/organizations/${orgId}/gst-registrations/${regId}/status`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        status: 'SUSPENDED',
        reason: 'Temporary audit hold'
      }
    });

    expect(suspendRes.statusCode).toBe(200);
    expect(suspendRes.json().data.gstRegistration.status).toBe('SUSPENDED');
    expect(suspendRes.json().data.gstRegistration.isActive).toBe(false);

    // 6. Cancel registration via PATCH .../status
    const cancelRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/organizations/${orgId}/gst-registrations/${regId}/status`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        status: 'CANCELLED',
        cancellationDate: '2025-12-31',
        reason: 'Statutory cancellation'
      }
    });

    expect(cancelRes.statusCode).toBe(200);
    expect(cancelRes.json().data.gstRegistration.status).toBe('CANCELLED');
    expect(cancelRes.json().data.gstRegistration.isActive).toBe(false);

    // 7. Verify historical accessibility: cancelled registration is still listed and queryable
    const listRes = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${orgId}/gst-registrations`,
      headers: { authorization: `Bearer ${tokenA}` }
    });

    expect(listRes.statusCode).toBe(200);
    const regs = listRes.json().data.registrations;
    expect(regs.length).toBe(1);
    expect(regs[0].id).toBe(regId);
    expect(regs[0].status).toBe('CANCELLED');
  });
});
