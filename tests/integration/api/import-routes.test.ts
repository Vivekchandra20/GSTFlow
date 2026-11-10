import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../../../src/app/app.js';
import { validateEnv } from '../../../src/config/env.js';
import { InMemoryAuthRepository } from '../../../src/modules/auth/in-memory-auth.repository.js';
import { InMemoryOrganizationRepository } from '../../../src/modules/organizations/in-memory-organization.repository.js';
import { InMemoryGstRegistrationRepository } from '../../../src/modules/gst-registrations/in-memory-gst-registration.repository.js';
import { InMemoryImportRepository } from '../../../src/modules/imports/in-memory-import.repository.js';
import { TokenService } from '../../../src/modules/auth/token.service.js';

describe('Secure Source File Upload & Import API Routes Integration Suite', () => {
  let app: FastifyInstance;
  let authRepo: InMemoryAuthRepository;
  let orgRepo: InMemoryOrganizationRepository;
  let gstRepo: InMemoryGstRegistrationRepository;
  let importRepo: InMemoryImportRepository;
  let tokenService: TokenService;

  const jwtSecret = 'test_jwt_access_secret_min_32_characters_long!';
  const orgId = '11111111-2222-4333-8444-555555555555';
  let activeGstRegId: string;

  let tokenOwner: string;
  let tokenAdmin: string;
  let tokenMember: string;
  let tokenViewer: string;
  let tokenOutsider: string;

  const buildMultipartPayload = (
    boundary: string,
    fields: Record<string, string>,
    file?: { fieldName: string; filename: string; mime: string; content: string }
  ): string => {
    const lines: string[] = [];

    for (const [key, val] of Object.entries(fields)) {
      lines.push(`--${boundary}`);
      lines.push(`Content-Disposition: form-data; name="${key}"`);
      lines.push('');
      lines.push(val);
    }

    if (file) {
      lines.push(`--${boundary}`);
      lines.push(`Content-Disposition: form-data; name="${file.fieldName}"; filename="${file.filename}"`);
      lines.push(`Content-Type: ${file.mime}`);
      lines.push('');
      lines.push(file.content);
    }

    lines.push(`--${boundary}--`);
    return lines.join('\r\n');
  };

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET = jwtSecret;
    process.env.COOKIE_SECRET = 'cookie-secret-at-least-32-characters-key!';
    process.env.JWT_ISSUER = 'gstflow-api';
    process.env.JWT_AUDIENCE = 'gstflow-client';

    authRepo = new InMemoryAuthRepository();
    orgRepo = new InMemoryOrganizationRepository();
    gstRepo = new InMemoryGstRegistrationRepository();
    importRepo = new InMemoryImportRepository();
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
      importRepository: importRepo,
      fastifyOverrides: { logger: false }
    });
    await app.ready();

    // 1. Create users
    const userOwner = await authRepo.createUser({ email: 'owner@example.com', normalizedEmail: 'owner@example.com', passwordHash: 'dummy' });
    const userAdmin = await authRepo.createUser({ email: 'admin@example.com', normalizedEmail: 'admin@example.com', passwordHash: 'dummy' });
    const userMember = await authRepo.createUser({ email: 'member@example.com', normalizedEmail: 'member@example.com', passwordHash: 'dummy' });
    const userViewer = await authRepo.createUser({ email: 'viewer@example.com', normalizedEmail: 'viewer@example.com', passwordHash: 'dummy' });
    const userOutsider = await authRepo.createUser({ email: 'outsider@example.com', normalizedEmail: 'outsider@example.com', passwordHash: 'dummy' });

    orgRepo.users.set(userOwner.id, userOwner);
    orgRepo.users.set(userAdmin.id, userAdmin);
    orgRepo.users.set(userMember.id, userMember);
    orgRepo.users.set(userViewer.id, userViewer);
    orgRepo.users.set(userOutsider.id, userOutsider);

    // 2. Setup organization and memberships
    await orgRepo.createOrganizationWithOwner({
      id: orgId,
      name: 'Acme Technologies Pvt Ltd',
      slug: 'acme-tech',
      pan: 'AAPFU0939F',
      userId: userOwner.id
    });

    orgRepo.memberships.set(`${orgId}:${userAdmin.id}`, {
      id: 'mem-admin',
      organizationId: orgId,
      userId: userAdmin.id,
      role: 'ADMIN',
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date()
    });

    orgRepo.memberships.set(`${orgId}:${userMember.id}`, {
      id: 'mem-member',
      organizationId: orgId,
      userId: userMember.id,
      role: 'MEMBER',
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date()
    });

    orgRepo.memberships.set(`${orgId}:${userViewer.id}`, {
      id: 'mem-viewer',
      organizationId: orgId,
      userId: userViewer.id,
      role: 'VIEWER',
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date()
    });

    // 3. Setup active GST Registration
    const activeReg = await gstRepo.create(orgId, {
      id: crypto.randomUUID(),
      organizationId: orgId,
      gstin: '27AAPFU0939F1ZV',
      legalName: 'Acme Technologies Maharashtra',
      stateCode: '27',
      pan: 'AAPFU0939F',
      registrationType: 'REGULAR',
      status: 'ACTIVE',
      isActive: true
    });
    activeGstRegId = activeReg.id;

    // 4. Generate JWTs
    tokenOwner = tokenService.signAccessToken(userOwner.id).accessToken;
    tokenAdmin = tokenService.signAccessToken(userAdmin.id).accessToken;
    tokenMember = tokenService.signAccessToken(userMember.id).accessToken;
    tokenViewer = tokenService.signAccessToken(userViewer.id).accessToken;
    tokenOutsider = tokenService.signAccessToken(userOutsider.id).accessToken;
  });

  describe('POST /api/v1/organizations/:organizationId/imports (Multipart Upload)', () => {
    const boundary = '----WebKitFormBoundaryTest12345';

    it('rejects unauthenticated upload requests with 401', async () => {
      const payload = buildMultipartPayload(boundary, { gstRegistrationId: activeGstRegId }, {
        fieldName: 'file',
        filename: 'sales.csv',
        mime: 'text/csv',
        content: 'Invoice Number,Amount\nINV-001,100\n'
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${orgId}/imports`,
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`
        },
        payload
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(false);
    });

    it('rejects unauthorized outsider user with 403', async () => {
      const payload = buildMultipartPayload(boundary, { gstRegistrationId: activeGstRegId }, {
        fieldName: 'file',
        filename: 'sales.csv',
        mime: 'text/csv',
        content: 'Invoice Number,Amount\nINV-001,100\n'
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${orgId}/imports`,
        headers: {
          authorization: `Bearer ${tokenOutsider}`,
          'content-type': `multipart/form-data; boundary=${boundary}`
        },
        payload
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('NOT_AN_ORGANIZATION_MEMBER');
    });

    it('rejects VIEWER role with 403 (insufficient permissions, requires import:create)', async () => {
      const payload = buildMultipartPayload(boundary, { gstRegistrationId: activeGstRegId }, {
        fieldName: 'file',
        filename: 'sales.csv',
        mime: 'text/csv',
        content: 'Invoice Number,Amount\nINV-001,100\n'
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${orgId}/imports`,
        headers: {
          authorization: `Bearer ${tokenViewer}`,
          'content-type': `multipart/form-data; boundary=${boundary}`
        },
        payload
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('allows MEMBER with import:create permission to upload and creates import batch with 201', async () => {
      const csvContent = 'Invoice Number,Taxable Value\nINV-MEMBER-001,1500.00\nINV-MEMBER-002,3000.00\n';
      const payload = buildMultipartPayload(
        boundary,
        {
          gstRegistrationId: activeGstRegId,
          sourcePlatform: 'AMAZON',
          metadata: JSON.stringify({ batchLabel: 'Q3 Ingestion' })
        },
        {
          fieldName: 'file',
          filename: 'amazon_nov_sales.csv',
          mime: 'text/csv',
          content: csvContent
        }
      );

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${orgId}/imports`,
        headers: {
          authorization: `Bearer ${tokenMember}`,
          'content-type': `multipart/form-data; boundary=${boundary}`
        },
        payload
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      expect(body.data.id).toBeDefined();
      expect(body.data.organizationId).toBe(orgId);
      expect(body.data.batchNumber).toMatch(/^BATCH-\d+-[A-Z0-9]+$/);
      expect(body.data.gstRegistrationId).toBe(activeGstRegId);
      expect(body.data.sourcePlatform).toBe('AMAZON');
      expect(body.data.lifecycleStatus).toBe('QUEUED');
      expect(body.data.status).toBe('PENDING');
    });

    it('rejects multipart request missing file part with 400', async () => {
      const payload = buildMultipartPayload(boundary, { gstRegistrationId: activeGstRegId });

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${orgId}/imports`,
        headers: {
          authorization: `Bearer ${tokenAdmin}`,
          'content-type': `multipart/form-data; boundary=${boundary}`
        },
        payload
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe('MALFORMED_UPLOAD');
    });

    it('rejects multipart request missing gstRegistrationId with 400', async () => {
      const payload = buildMultipartPayload(
        boundary,
        {},
        {
          fieldName: 'file',
          filename: 'sales.csv',
          mime: 'text/csv',
          content: 'Invoice Number,Amount\nINV-001,100\n'
        }
      );

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${orgId}/imports`,
        headers: {
          authorization: `Bearer ${tokenAdmin}`,
          'content-type': `multipart/form-data; boundary=${boundary}`
        },
        payload
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe('MALFORMED_UPLOAD');
    });

    it('rejects unsupported file formats (e.g. .exe / .xlsx) with 400', async () => {
      const payload = buildMultipartPayload(
        boundary,
        { gstRegistrationId: activeGstRegId },
        {
          fieldName: 'file',
          filename: 'script.exe',
          mime: 'application/octet-stream',
          content: 'binary content'
        }
      );

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${orgId}/imports`,
        headers: {
          authorization: `Bearer ${tokenOwner}`,
          'content-type': `multipart/form-data; boundary=${boundary}`
        },
        payload
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe('UNSUPPORTED_FILE_TYPE');
    });

    it('rejects empty file uploads (0 bytes) with 400', async () => {
      const payload = buildMultipartPayload(
        boundary,
        { gstRegistrationId: activeGstRegId },
        {
          fieldName: 'file',
          filename: 'empty.csv',
          mime: 'text/csv',
          content: ''
        }
      );

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${orgId}/imports`,
        headers: {
          authorization: `Bearer ${tokenOwner}`,
          'content-type': `multipart/form-data; boundary=${boundary}`
        },
        payload
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe('EMPTY_FILE');
    });
  });

  describe('GET /api/v1/organizations/:organizationId/imports (List Imports)', () => {
    it('allows VIEWER to list organization imports with 200', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${orgId}/imports?page=1&limit=10`,
        headers: {
          authorization: `Bearer ${tokenViewer}`
        }
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data.items)).toBe(true);
      expect(body.data.pagination.page).toBe(1);
      expect(body.data.pagination.limit).toBe(10);
      expect(body.data.pagination.totalItems).toBeGreaterThanOrEqual(1);
    });

    it('supports status and sourcePlatform query filters', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${orgId}/imports?status=PENDING&sourcePlatform=AMAZON`,
        headers: {
          authorization: `Bearer ${tokenAdmin}`
        }
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      for (const item of body.data.items) {
        expect(item.status).toBe('PENDING');
        expect(item.sourcePlatform).toBe('AMAZON');
      }
    });
  });

  describe('GET /api/v1/organizations/:organizationId/imports/:batchId (Get Import Details)', () => {
    it('retrieves details for an existing import batch with 200', async () => {
      // First list to get an id
      const listRes = await app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${orgId}/imports`,
        headers: { authorization: `Bearer ${tokenOwner}` }
      });
      const batchId = JSON.parse(listRes.payload).data.items[0].id;

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${orgId}/imports/${batchId}`,
        headers: { authorization: `Bearer ${tokenViewer}` }
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      expect(body.data.id).toBe(batchId);
      expect(body.data.organizationId).toBe(orgId);
    });

    it('returns 404 for a non-existent batchId', async () => {
      const fakeBatchId = crypto.randomUUID();
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${orgId}/imports/${fakeBatchId}`,
        headers: { authorization: `Bearer ${tokenOwner}` }
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe('IMPORT_NOT_FOUND');
    });
  });

  describe('GET /api/v1/organizations/:organizationId/imports/:batchId/status (Get Status & Job)', () => {
    it('returns 200 with job checkpoints and staging status', async () => {
      const listRes = await app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${orgId}/imports`,
        headers: { authorization: `Bearer ${tokenOwner}` }
      });
      const batchId = JSON.parse(listRes.payload).data.items[0].id;

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${orgId}/imports/${batchId}/status`,
        headers: { authorization: `Bearer ${tokenMember}` }
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      expect(body.data.batchId).toBe(batchId);
      expect(body.data.lifecycleStatus).toBeDefined();
      expect(body.data.job).toBeDefined();
    });
  });

  describe('GET /api/v1/organizations/:organizationId/imports/:batchId/summary (Get Summary)', () => {
    it('returns 200 with persisted counts and financial summaries', async () => {
      const listRes = await app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${orgId}/imports`,
        headers: { authorization: `Bearer ${tokenOwner}` }
      });
      const batchId = JSON.parse(listRes.payload).data.items[0].id;

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${orgId}/imports/${batchId}/summary`,
        headers: { authorization: `Bearer ${tokenAdmin}` }
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      expect(body.data.batchId).toBe(batchId);
      expect(body.data.persistedCounts).toBeDefined();
    });
  });
});
