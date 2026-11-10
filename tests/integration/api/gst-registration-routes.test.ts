import { describe, it, expect, beforeAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../../../src/app/app.js';
import { validateEnv } from '../../../src/config/env.js';
import { InMemoryAuthRepository } from '../../../src/modules/auth/in-memory-auth.repository.js';
import { InMemoryOrganizationRepository } from '../../../src/modules/organizations/in-memory-organization.repository.js';
import { InMemoryGstRegistrationRepository } from '../../../src/modules/gst-registrations/in-memory-gst-registration.repository.js';
import { TokenService } from '../../../src/modules/auth/token.service.js';

describe('GST Registration API Routes & RBAC Integration Suite', () => {
  let app: FastifyInstance;
  let authRepo: InMemoryAuthRepository;
  let orgRepo: InMemoryOrganizationRepository;
  let gstRepo: InMemoryGstRegistrationRepository;
  let tokenService: TokenService;

  const jwtSecret = 'test_jwt_access_secret_min_32_characters_long!';
  const orgId = '11111111-2222-4333-8444-555555555555';

  let userOwner: any;
  let userAdmin: any;
  let userMember: any;
  let userViewer: any;
  let userOutsider: any;

  let tokenOwner: string;
  let tokenAdmin: string;
  let tokenMember: string;
  let tokenViewer: string;
  let tokenOutsider: string;

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET = jwtSecret;
    process.env.COOKIE_SECRET = 'cookie-secret-at-least-32-characters-key!';
    process.env.JWT_ISSUER = 'gstflow-api';
    process.env.JWT_AUDIENCE = 'gstflow-client';

    authRepo = new InMemoryAuthRepository();
    orgRepo = new InMemoryOrganizationRepository();
    gstRepo = new InMemoryGstRegistrationRepository();
    tokenService = new TokenService();

    app = await buildApp({
      env: validateEnv({
        NODE_ENV: 'test',
        JWT_ACCESS_SECRET: jwtSecret,
        COOKIE_SECRET: 'cookie-secret-at-least-32-characters-key!'
      }),
      authRepository: authRepo,
      organizationRepository: orgRepo,
      gstRegistrationRepository: gstRepo,
      fastifyOverrides: { logger: false }
    });
    await app.ready();

    // 1. Create users in authRepo
    userOwner = await authRepo.createUser({
      email: 'owner@example.com',
      normalizedEmail: 'owner@example.com',
      passwordHash: 'dummy'
    });
    userAdmin = await authRepo.createUser({
      email: 'admin@example.com',
      normalizedEmail: 'admin@example.com',
      passwordHash: 'dummy'
    });
    userMember = await authRepo.createUser({
      email: 'member@example.com',
      normalizedEmail: 'member@example.com',
      passwordHash: 'dummy'
    });
    userViewer = await authRepo.createUser({
      email: 'viewer@example.com',
      normalizedEmail: 'viewer@example.com',
      passwordHash: 'dummy'
    });
    userOutsider = await authRepo.createUser({
      email: 'outsider@example.com',
      normalizedEmail: 'outsider@example.com',
      passwordHash: 'dummy'
    });

    orgRepo.users.set(userOwner.id, userOwner);
    orgRepo.users.set(userAdmin.id, userAdmin);
    orgRepo.users.set(userMember.id, userMember);
    orgRepo.users.set(userViewer.id, userViewer);
    orgRepo.users.set(userOutsider.id, userOutsider);

    // 2. Create organization
    await orgRepo.createOrganizationWithOwner({
      id: orgId,
      name: 'GST Corporate Org',
      slug: 'gst-corp',
      pan: null,
      userId: userOwner.id
    });

    // 3. Add memberships
    const now = new Date();
    orgRepo.memberships.set(`${orgId}:${userAdmin.id}`, {
      id: 'mem-admin',
      organizationId: orgId,
      userId: userAdmin.id,
      role: 'ADMIN',
      status: 'ACTIVE',
      joinedAt: now,
      createdAt: now,
      updatedAt: now
    });

    orgRepo.memberships.set(`${orgId}:${userMember.id}`, {
      id: 'mem-member',
      organizationId: orgId,
      userId: userMember.id,
      role: 'MEMBER',
      status: 'ACTIVE',
      joinedAt: now,
      createdAt: now,
      updatedAt: now
    });

    orgRepo.memberships.set(`${orgId}:${userViewer.id}`, {
      id: 'mem-viewer',
      organizationId: orgId,
      userId: userViewer.id,
      role: 'VIEWER',
      status: 'ACTIVE',
      joinedAt: now,
      createdAt: now,
      updatedAt: now
    });

    // 4. Generate tokens
    tokenOwner = tokenService.signAccessToken(userOwner.id).accessToken;
    tokenAdmin = tokenService.signAccessToken(userAdmin.id).accessToken;
    tokenMember = tokenService.signAccessToken(userMember.id).accessToken;
    tokenViewer = tokenService.signAccessToken(userViewer.id).accessToken;
    tokenOutsider = tokenService.signAccessToken(userOutsider.id).accessToken;
  });

  // 1. POST /organizations/:organizationId/gst-registrations
  describe('POST /api/v1/organizations/:organizationId/gst-registrations', () => {
    it('allows OWNER to register a valid GSTIN', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${orgId}/gst-registrations`,
        headers: { authorization: `Bearer ${tokenOwner}` },
        payload: {
          gstin: '27AAPFU0939F1ZV',
          legalName: 'Maharashtra Entity Pvt Ltd',
          tradeName: 'Maha Tech',
          registrationType: 'REGULAR',
          effectiveDate: '2024-04-01'
        }
      });

      expect(res.statusCode).toBe(201);
      const data = res.json().data.gstRegistration;
      expect(data.id).toBeDefined();
      expect(data.gstin).toBe('27AAPFU0939F1ZV');
      expect(data.stateCode).toBe('27');
      expect(data.pan).toBe('AAPFU0939F');
      expect(data.status).toBe('ACTIVE');
      expect(data.isActive).toBe(true);
    });

    it('allows ADMIN to register a valid GSTIN', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${orgId}/gst-registrations`,
        headers: { authorization: `Bearer ${tokenAdmin}` },
        payload: {
          gstin: '29AABCU9603R1ZJ',
          legalName: 'Karnataka Entity Pvt Ltd'
        }
      });

      expect(res.statusCode).toBe(201);
      const data = res.json().data.gstRegistration;
      expect(data.gstin).toBe('29AABCU9603R1ZJ');
      expect(data.stateCode).toBe('29');
    });

    it('denies MEMBER from creating a GST registration (403 INSUFFICIENT_PERMISSIONS)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${orgId}/gst-registrations`,
        headers: { authorization: `Bearer ${tokenMember}` },
        payload: {
          gstin: '07AAAAA0000A1Z4',
          legalName: 'Delhi Entity'
        }
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('denies VIEWER from creating a GST registration (403 INSUFFICIENT_PERMISSIONS)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${orgId}/gst-registrations`,
        headers: { authorization: `Bearer ${tokenViewer}` },
        payload: {
          gstin: '07AAAAA0000A1Z4',
          legalName: 'Delhi Entity'
        }
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('denies non-member from registering a GSTIN (403 NOT_AN_ORGANIZATION_MEMBER)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${orgId}/gst-registrations`,
        headers: { authorization: `Bearer ${tokenOutsider}` },
        payload: {
          gstin: '07AAAAA0000A1Z4',
          legalName: 'Outsider Attempt'
        }
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('NOT_AN_ORGANIZATION_MEMBER');
    });

    it('rejects unauthenticated requests (401 UNAUTHENTICATED)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${orgId}/gst-registrations`,
        payload: {
          gstin: '27AAPFU0939F1ZV',
          legalName: 'No Auth'
        }
      });

      expect(res.statusCode).toBe(401);
    });

    it('rejects duplicate GSTIN registrations in the same organization (409 DUPLICATE_GSTIN_REGISTRATION)', async () => {
      // 27AAPFU0939F1ZV was already registered earlier
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${orgId}/gst-registrations`,
        headers: { authorization: `Bearer ${tokenOwner}` },
        payload: {
          gstin: '27AAPFU0939F1ZV',
          legalName: 'Duplicate Registration'
        }
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('DUPLICATE_GSTIN_REGISTRATION');
    });

    it('rejects malformed GSTIN or invalid checksum (400 INVALID_GSTIN / VALIDATION_ERROR)', async () => {
      // Invalid checksum (expected '4', provided 'X')
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${orgId}/gst-registrations`,
        headers: { authorization: `Bearer ${tokenOwner}` },
        payload: {
          gstin: '07AAAAA0000A1ZX',
          legalName: 'Bad Checksum Entity'
        }
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_GSTIN');
    });
  });

  // 2. GET /organizations/:organizationId/gst-registrations
  describe('GET /api/v1/organizations/:organizationId/gst-registrations', () => {
    it('allows VIEWER and MEMBER to list registrations with pagination and filtering', async () => {
      const resViewer = await app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${orgId}/gst-registrations?limit=10&page=1`,
        headers: { authorization: `Bearer ${tokenViewer}` }
      });

      expect(resViewer.statusCode).toBe(200);
      const data = resViewer.json().data;
      expect(data.registrations.length).toBeGreaterThanOrEqual(2);
      expect(data.pagination.page).toBe(1);
      expect(data.pagination.limit).toBe(10);

      // Filter by stateCode=27
      const resFilter = await app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${orgId}/gst-registrations?stateCode=27`,
        headers: { authorization: `Bearer ${tokenMember}` }
      });

      expect(resFilter.statusCode).toBe(200);
      const filterData = resFilter.json().data;
      expect(filterData.registrations.every((r: any) => r.stateCode === '27')).toBe(true);
    });

    it('denies outsider from listing organization GST registrations (403)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${orgId}/gst-registrations`,
        headers: { authorization: `Bearer ${tokenOutsider}` }
      });

      expect(res.statusCode).toBe(403);
    });
  });

  // 3. GET /organizations/:organizationId/gst-registrations/:gstRegistrationId
  describe('GET /api/v1/organizations/:organizationId/gst-registrations/:gstRegistrationId', () => {
    let regId: string;

    beforeAll(async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${orgId}/gst-registrations`,
        headers: { authorization: `Bearer ${tokenOwner}` },
        payload: {
          gstin: '33AAACA1234A1ZR',
          legalName: 'Tamil Nadu Entity'
        }
      });
      regId = res.json().data.gstRegistration.id;
    });

    it('allows MEMBER to retrieve individual registration details', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${orgId}/gst-registrations/${regId}`,
        headers: { authorization: `Bearer ${tokenMember}` }
      });

      expect(res.statusCode).toBe(200);
      const data = res.json().data.gstRegistration;
      expect(data.id).toBe(regId);
      expect(data.gstin).toBe('33AAACA1234A1ZR');
      expect(data.stateCode).toBe('33');
    });

    it('returns 404 for non-existent registration ID', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${orgId}/gst-registrations/00000000-0000-0000-0000-000000000000`,
        headers: { authorization: `Bearer ${tokenOwner}` }
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('GST_REGISTRATION_NOT_FOUND');
    });
  });

  // 4. PATCH /organizations/:organizationId/gst-registrations/:gstRegistrationId
  describe('PATCH /api/v1/organizations/:organizationId/gst-registrations/:gstRegistrationId', () => {
    let regId: string;

    beforeAll(async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${orgId}/gst-registrations`,
        headers: { authorization: `Bearer ${tokenOwner}` },
        payload: {
          gstin: '07AAAAA0000A1Z4',
          legalName: 'Original Delhi Legal Name'
        }
      });
      regId = res.json().data.gstRegistration.id;
    });

    it('allows ADMIN to update permitted fields', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/organizations/${orgId}/gst-registrations/${regId}`,
        headers: { authorization: `Bearer ${tokenAdmin}` },
        payload: {
          legalName: 'Updated Delhi Legal Name',
          tradeName: 'Delhi Central Hub',
          registrationType: 'COMPOSITION'
        }
      });

      expect(res.statusCode).toBe(200);
      const data = res.json().data.gstRegistration;
      expect(data.legalName).toBe('Updated Delhi Legal Name');
      expect(data.tradeName).toBe('Delhi Central Hub');
      expect(data.registrationType).toBe('COMPOSITION');
      expect(data.gstin).toBe('07AAAAA0000A1Z4'); // immutable
    });

    it('denies MEMBER from updating registration details (403)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/organizations/${orgId}/gst-registrations/${regId}`,
        headers: { authorization: `Bearer ${tokenMember}` },
        payload: { legalName: 'Member Unauthorized Edit' }
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('INSUFFICIENT_PERMISSIONS');
    });
  });

  // 5. PATCH /organizations/:organizationId/gst-registrations/:gstRegistrationId/status
  describe('PATCH /api/v1/organizations/:organizationId/gst-registrations/:gstRegistrationId/status', () => {
    let regId: string;

    beforeAll(async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${orgId}/gst-registrations`,
        headers: { authorization: `Bearer ${tokenOwner}` },
        payload: {
          gstin: '24AAAAA0000A1Z8', // Valid check digit '8' for 24AAAAA0000A1Z
          legalName: 'Gujarat Entity'
        }
      });
      regId = res.json().data.gstRegistration.id;
    });

    it('allows OWNER to suspend a registration', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/organizations/${orgId}/gst-registrations/${regId}/status`,
        headers: { authorization: `Bearer ${tokenOwner}` },
        payload: {
          status: 'SUSPENDED',
          reason: 'Regulatory verification in progress'
        }
      });

      expect(res.statusCode).toBe(200);
      const data = res.json().data.gstRegistration;
      expect(data.status).toBe('SUSPENDED');
      expect(data.isActive).toBe(false);
    });

    it('allows ADMIN to cancel a registration and sets cancellationDate', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/organizations/${orgId}/gst-registrations/${regId}/status`,
        headers: { authorization: `Bearer ${tokenAdmin}` },
        payload: {
          status: 'CANCELLED',
          cancellationDate: '2025-06-30',
          reason: 'Business surrendered GSTIN'
        }
      });

      expect(res.statusCode).toBe(200);
      const data = res.json().data.gstRegistration;
      expect(data.status).toBe('CANCELLED');
      expect(data.isActive).toBe(false);
      expect(data.cancellationDate).toBeDefined();
    });

    it('rejects reactivation of a CANCELLED registration (409 INVALID_STATUS_TRANSITION)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/organizations/${orgId}/gst-registrations/${regId}/status`,
        headers: { authorization: `Bearer ${tokenOwner}` },
        payload: {
          status: 'ACTIVE'
        }
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('INVALID_STATUS_TRANSITION');
    });

    it('denies MEMBER from changing registration status (403)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/organizations/${orgId}/gst-registrations/${regId}/status`,
        headers: { authorization: `Bearer ${tokenMember}` },
        payload: { status: 'INACTIVE' }
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('INSUFFICIENT_PERMISSIONS');
    });
  });
});
