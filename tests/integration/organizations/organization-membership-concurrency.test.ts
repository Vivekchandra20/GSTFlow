import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaAuthRepository } from '../../../src/modules/auth/auth.repository.js';
import { PrismaOrganizationRepository } from '../../../src/modules/organizations/organization.repository.js';
import { OrganizationService } from '../../../src/modules/organizations/organization.service.js';
import { MembershipService } from '../../../src/modules/memberships/membership.service.js';
import { InvitationService } from '../../../src/modules/invitations/invitation.service.js';
import {
  CannotDemoteLastOwnerError,
  CannotRemoveLastOwnerError,
  InvitationAlreadyAcceptedError,
  AlreadyOrganizationMemberError
} from '../../../src/modules/authorization/authorization.errors.js';
import { buildApp } from '../../../src/app/app.js';
import { FastifyInstance } from 'fastify';
import { TokenService } from '../../../src/modules/auth/token.service.js';
import { validateEnv } from '../../../src/config/env.js';

describe('Phase 4.2.3: Organization, Membership, RBAC & PostgreSQL RLS Integration Suite', () => {
  let pgServer: any;
  let adminClient: pg.Client;
  let prisma: PrismaClient;
  let authRepo: PrismaAuthRepository;
  let orgRepo: PrismaOrganizationRepository;
  let orgService: OrganizationService;
  let memberService: MembershipService;
  let invitationService: InvitationService;
  let app: FastifyInstance;
  let tokenService: TokenService;

  const testDbName = 'gstflow_phase4_2_3_org_db';
  const testPort = 54346;
  const dataDir = path.resolve('.pgdata_phase4_2_3_org');

  let userA: any;
  let userB: any;
  let userC: any;

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET = 'test-secret-at-least-32-chars-for-testing!';
    process.env.COOKIE_SECRET = 'cookie-secret-at-least-32-characters-key!';

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

    // 3. Connect to test DB as admin and apply all 4 migrations
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
    orgService = new OrganizationService(orgRepo);
    memberService = new MembershipService(orgRepo);
    invitationService = new InvitationService(orgRepo);
    tokenService = new TokenService();

    // 5. Seed test users
    userA = await authRepo.createUser({
      email: 'usera@example.com',
      normalizedEmail: 'usera@example.com',
      passwordHash: 'dummyhash'
    });
    userB = await authRepo.createUser({
      email: 'userb@example.com',
      normalizedEmail: 'userb@example.com',
      passwordHash: 'dummyhash'
    });
    userC = await authRepo.createUser({
      email: 'userc@example.com',
      normalizedEmail: 'userc@example.com',
      passwordHash: 'dummyhash'
    });

    // 6. Build Fastify App with PostgreSQL prisma
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
    if (app) await app.close();
    if (prisma) await prisma.$disconnect();
    if (adminClient) await adminClient.end();
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

  it('atomically creates organization with initial OWNER membership in PostgreSQL', async () => {
    const result = await orgService.createOrganization(userA.id, {
      name: 'Alpha Enterprises',
      pan: 'ABCDE1234A'
    });

    expect(result.organization.id).toBeDefined();
    expect(result.organization.name).toBe('Alpha Enterprises');
    expect(result.membership.role).toBe('OWNER');

    // Verify creator sees organization via listUserOrganizations
    const orgs = await orgService.listUserOrganizations(userA.id);
    expect(orgs.length).toBe(1);
    expect(orgs[0].id).toBe(result.organization.id);
    expect(orgs[0].role).toBe('OWNER');

    // Verify other users do not see this organization
    const orgsB = await orgService.listUserOrganizations(userB.id);
    expect(orgsB.length).toBe(0);
  });

  it('prevents demotion of last OWNER under concurrent attempts via row locking', async () => {
    // Create dedicated organization for concurrency test
    const { organization } = await orgService.createOrganization(userA.id, {
      name: 'Sole Owner Corp'
    });
    const orgId = organization.id;

    // Concurrently fire 2 demotion requests attempting to demote the sole owner to ADMIN
    const results = await Promise.allSettled([
      memberService.updateMemberRole(orgId, userA.id, 'ADMIN', userA.id, 'OWNER'),
      memberService.updateMemberRole(orgId, userA.id, 'ADMIN', userA.id, 'OWNER')
    ]);

    // Both concurrent attempts MUST be rejected with CannotDemoteLastOwnerError
    for (const res of results) {
      expect(res.status).toBe('rejected');
      if (res.status === 'rejected') {
        expect(res.reason).toBeInstanceOf(CannotDemoteLastOwnerError);
      }
    }

    // Assert that userA is STILL an active OWNER in PostgreSQL
    const details = await orgRepo.getUserMembershipDetails(userA.id, orgId);
    expect(details?.role).toBe('OWNER');
    expect(details?.membershipStatus).toBe('ACTIVE');
  });

  it('serializes concurrent invitation acceptance via row locking', async () => {
    const { organization } = await orgService.createOrganization(userA.id, {
      name: 'Invite Test Corp'
    });
    const orgId = organization.id;

    const invite = await invitationService.createInvitation(orgId, userA.id, {
      email: userB.email,
      role: 'ADMIN'
    });

    // Concurrently fire 2 acceptance requests for the same token
    const results = await Promise.allSettled([
      invitationService.acceptInvitation(invite.invitationToken, {
        userId: userB.id,
        email: userB.email
      }),
      invitationService.acceptInvitation(invite.invitationToken, {
        userId: userB.id,
        email: userB.email
      })
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Exactly ONE request must succeed; the second must fail due to row locking and acceptedAt check
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    if (rejected[0].status === 'rejected') {
      expect(
        rejected[0].reason instanceof InvitationAlreadyAcceptedError ||
        rejected[0].reason instanceof AlreadyOrganizationMemberError
      ).toBe(true);
    }
  });

  it('strictly enforces PostgreSQL Row-Level Security across distinct organizations', async () => {
    // 1. Create Organization 1 (owned by userA)
    const org1Res = await orgService.createOrganization(userA.id, { name: 'Org Alpha' });
    const org1Id = org1Res.organization.id;

    // 2. Create Organization 2 (owned by userB)
    const org2Res = await orgService.createOrganization(userB.id, { name: 'Org Beta' });
    const org2Id = org2Res.organization.id;

    // 3. Insert canonical invoices for both orgs as admin
    const inv1Id = crypto.randomUUID();
    const inv2Id = crypto.randomUUID();

    await adminClient.query(`
      INSERT INTO canonical_invoices (id, organization_id, seller_gstin, financial_year, invoice_number, invoice_date, order_id, recipient_type, ship_from_state_code, place_of_supply_state_code, supply_type, created_at)
      VALUES 
        ('${inv1Id}', '${org1Id}', '27AAAAA0000A1Z5', '2024-2025', 'INV-001', '2024-05-01', 'ORD-001', 'B2B', '27', '29', 'INTERSTATE', NOW()),
        ('${inv2Id}', '${org2Id}', '29BBBBB0000B1Z5', '2024-2025', 'INV-002', '2024-05-01', 'ORD-002', 'B2B', '29', '27', 'INTERSTATE', NOW());
    `);

    // 4. Query under Org 1's tenant context: only Org 1's invoice must be visible
    await orgRepo.runInTenantTransaction(org1Id, async (tx) => {
      const invoices = await tx.$queryRaw<any[]>`SELECT * FROM canonical_invoices;`;
      expect(invoices.length).toBe(1);
      expect(invoices[0].id).toBe(inv1Id);
      expect(invoices[0].organization_id).toBe(org1Id);

      // Attempting to query Org 2's invoice directly returns empty
      const targetInvoice = await tx.$queryRaw<any[]>`
        SELECT * FROM canonical_invoices WHERE id = ${inv2Id}::uuid;
      `;
      expect(targetInvoice.length).toBe(0);
    });

    // 5. Query under Org 2's tenant context: only Org 2's invoice must be visible
    await orgRepo.runInTenantTransaction(org2Id, async (tx) => {
      const invoices = await tx.$queryRaw<any[]>`SELECT * FROM canonical_invoices;`;
      expect(invoices.length).toBe(1);
      expect(invoices[0].id).toBe(inv2Id);
      expect(invoices[0].organization_id).toBe(org2Id);
    });
  });

  it('runs complete organization and membership workflow via Fastify HTTP endpoints against PostgreSQL', async () => {
    const tokenA = tokenService.signAccessToken(userA.id).accessToken;
    const tokenC = tokenService.signAccessToken(userC.id).accessToken;

    // 1. User A creates an organization
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { name: 'Full HTTP Flow Org', pan: 'AACCE1234D' }
    });

    expect(createRes.statusCode).toBe(201);
    const orgId = createRes.json().data.organization.id;

    // 2. User A invites User C as MEMBER
    const inviteRes = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${orgId}/invitations`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { email: userC.email, role: 'MEMBER' }
    });

    expect(inviteRes.statusCode).toBe(201);
    const invitationToken = inviteRes.json().data.invitationToken;

    // 3. User C accepts the invitation
    const acceptRes = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      headers: { authorization: `Bearer ${tokenC}` },
      payload: { token: invitationToken }
    });

    expect(acceptRes.statusCode).toBe(200);

    // 4. User C lists organizations: now contains the new organization
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/organizations',
      headers: { authorization: `Bearer ${tokenC}` }
    });

    expect(listRes.statusCode).toBe(200);
    const orgList = listRes.json().data.organizations;
    expect(orgList.some((o: any) => o.id === orgId)).toBe(true);

    // 5. User C reads organization details
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${orgId}`,
      headers: { authorization: `Bearer ${tokenC}` }
    });

    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().data.organization.name).toBe('Full HTTP Flow Org');
  });
});
