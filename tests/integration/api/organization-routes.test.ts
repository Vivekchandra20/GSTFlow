import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../../../src/app/app.js';
import { InMemoryAuthRepository } from '../../../src/modules/auth/in-memory-auth.repository.js';
import { InMemoryOrganizationRepository } from '../../../src/modules/organizations/in-memory-organization.repository.js';
import { TokenService } from '../../../src/modules/auth/token.service.js';
import { validateEnv } from '../../../src/config/env.js';

describe('Phase 4.2.3: Organization & RBAC HTTP Integration Suite', () => {
  let app: FastifyInstance;
  let authRepo: InMemoryAuthRepository;
  let orgRepo: InMemoryOrganizationRepository;
  let tokenService: TokenService;

  let ownerToken: string;
  let adminToken: string;
  let memberToken: string;
  let strangerToken: string;

  let ownerUser: any;
  let adminUser: any;
  let memberUser: any;
  let strangerUser: any;

  let organizationId: string;

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET = 'test-secret-at-least-32-chars-for-testing!';
    process.env.COOKIE_SECRET = 'cookie-secret-at-least-32-characters-key!';

    authRepo = new InMemoryAuthRepository();
    orgRepo = new InMemoryOrganizationRepository();
    tokenService = new TokenService();

    app = await buildApp({
      env: validateEnv({
        NODE_ENV: 'test',
        JWT_ACCESS_SECRET: 'test-secret-at-least-32-chars-for-testing!',
        COOKIE_SECRET: 'cookie-secret-at-least-32-characters-key!'
      }),
      authRepository: authRepo,
      organizationRepository: orgRepo,
      fastifyOverrides: { logger: false }
    });
    await app.ready();

    // 1. Create test users in authRepo
    ownerUser = await authRepo.createUser({
      email: 'owner@example.com',
      normalizedEmail: 'owner@example.com',
      passwordHash: 'dummy'
    });
    adminUser = await authRepo.createUser({
      email: 'admin@example.com',
      normalizedEmail: 'admin@example.com',
      passwordHash: 'dummy'
    });
    memberUser = await authRepo.createUser({
      email: 'member@example.com',
      normalizedEmail: 'member@example.com',
      passwordHash: 'dummy'
    });
    strangerUser = await authRepo.createUser({
      email: 'stranger@example.com',
      normalizedEmail: 'stranger@example.com',
      passwordHash: 'dummy'
    });

    orgRepo.users.set(ownerUser.id, ownerUser);
    orgRepo.users.set(adminUser.id, adminUser);
    orgRepo.users.set(memberUser.id, memberUser);
    orgRepo.users.set(strangerUser.id, strangerUser);

    ownerToken = tokenService.signAccessToken(ownerUser.id).accessToken;
    adminToken = tokenService.signAccessToken(adminUser.id).accessToken;
    memberToken = tokenService.signAccessToken(memberUser.id).accessToken;
    strangerToken = tokenService.signAccessToken(strangerUser.id).accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Organization Lifecycle (CRUD)', () => {
    it('creates an organization and assigns creator as OWNER (POST /organizations)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/organizations',
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          name: 'Nexus Tech Pvt Ltd',
          pan: 'ABCDE1234F'
        }
      });

      expect(response.statusCode).toBe(201);
      const json = response.json();
      expect(json.success).toBe(true);
      expect(json.data.organization.name).toBe('Nexus Tech Pvt Ltd');
      expect(json.data.membership.role).toBe('OWNER');

      organizationId = json.data.organization.id;

      // Add admin and member to the organization
      await orgRepo.acceptInvitation('dummy1', organizationId, adminUser.id, 'ADMIN', null);
      await orgRepo.acceptInvitation('dummy2', organizationId, memberUser.id, 'MEMBER', null);
    });

    it('lists organizations for member user (GET /organizations)', async () => {
      const resOwner = await app.inject({
        method: 'GET',
        url: '/api/v1/organizations',
        headers: { authorization: `Bearer ${ownerToken}` }
      });

      expect(resOwner.statusCode).toBe(200);
      expect(resOwner.json().data.organizations.length).toBe(1);

      // Stranger user sees 0 organizations
      const resStranger = await app.inject({
        method: 'GET',
        url: '/api/v1/organizations',
        headers: { authorization: `Bearer ${strangerToken}` }
      });

      expect(resStranger.statusCode).toBe(200);
      expect(resStranger.json().data.organizations.length).toBe(0);
    });

    it('allows member to read organization details (GET /organizations/:id)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${organizationId}`,
        headers: { authorization: `Bearer ${memberToken}` }
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data.organization.id).toBe(organizationId);
    });

    it('rejects non-member access to organization details with 403 NOT_AN_ORGANIZATION_MEMBER', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${organizationId}`,
        headers: { authorization: `Bearer ${strangerToken}` }
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('NOT_AN_ORGANIZATION_MEMBER');
    });

    it('allows ADMIN to update organization details (PATCH /organizations/:id)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/organizations/${organizationId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'Nexus Tech Global Pvt Ltd'
        }
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data.organization.name).toBe('Nexus Tech Global Pvt Ltd');
    });

    it('denies MEMBER from updating organization with 403 INSUFFICIENT_PERMISSIONS', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/organizations/${organizationId}`,
        headers: { authorization: `Bearer ${memberToken}` },
        payload: { name: 'Hacked Name' }
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('INSUFFICIENT_PERMISSIONS');
    });
  });

  describe('Membership & RBAC Operations', () => {
    it('lists organization members (GET /organizations/:id/members)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${organizationId}/members`,
        headers: { authorization: `Bearer ${memberToken}` }
      });

      expect(res.statusCode).toBe(200);
      const members = res.json().data.members;
      expect(members.length).toBe(3);
    });

    it('allows OWNER to update member role (PATCH /organizations/:id/members/:userId)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/organizations/${organizationId}/members/${memberUser.id}`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { role: 'ADMIN' }
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data.membership.role).toBe('ADMIN');
    });

    it('denies MEMBER from updating member roles with 403 INSUFFICIENT_PERMISSIONS', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/organizations/${organizationId}/members/${adminUser.id}`,
        headers: { authorization: `Bearer ${strangerToken}` },
        payload: { role: 'VIEWER' }
      });

      expect(res.statusCode).toBe(403);
    });

    it('protects last OWNER from demotion (returns 400 CANNOT_DEMOTE_LAST_OWNER)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/organizations/${organizationId}/members/${ownerUser.id}`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { role: 'ADMIN' }
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('CANNOT_DEMOTE_LAST_OWNER');
    });

    it('protects last OWNER from removal (DELETE /organizations/:id/members/:userId)', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/organizations/${organizationId}/members/${ownerUser.id}`,
        headers: { authorization: `Bearer ${ownerToken}` }
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('CANNOT_REMOVE_LAST_OWNER');
    });

    it('protects last OWNER from leaving (POST /organizations/:id/leave)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${organizationId}/leave`,
        headers: { authorization: `Bearer ${ownerToken}` }
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('CANNOT_REMOVE_LAST_OWNER');
    });
  });

  describe('Invitation System Lifecycle', () => {
    let invitationToken: string;
    let invitationId: string;

    it('creates an invitation (POST /organizations/:id/invitations)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${organizationId}/invitations`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          email: 'stranger@example.com',
          role: 'VIEWER'
        }
      });

      expect(res.statusCode).toBe(201);
      const json = res.json();
      expect(json.success).toBe(true);
      expect(json.data.invitationToken).toBeDefined();
      expect(json.data.role).toBe('VIEWER');

      invitationToken = json.data.invitationToken;
      invitationId = json.data.id;
    });

    it('rejects invitation for OWNER role with 400 CANNOT_INVITE_OWNER', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${organizationId}/invitations`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          email: 'newboss@example.com',
          role: 'OWNER'
        }
      });

      expect(res.statusCode).toBe(400);
    });

    it('lists pending invitations (GET /organizations/:id/invitations)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${organizationId}/invitations`,
        headers: { authorization: `Bearer ${adminToken}` }
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data.invitations.length).toBeGreaterThanOrEqual(1);
    });

    it('rejects acceptance if signed-in user does not match recipient email (403 INVITATION_EMAIL_MISMATCH)', async () => {
      // Owner (owner@example.com) attempts to accept invitation sent to stranger@example.com
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/invitations/accept',
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { token: invitationToken }
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('INVITATION_EMAIL_MISMATCH');
    });

    it('allows rightful recipient to accept invitation (POST /invitations/accept)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/invitations/accept',
        headers: { authorization: `Bearer ${strangerToken}` },
        payload: { token: invitationToken }
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.success).toBe(true);
      expect(json.data.organizationId).toBe(organizationId);
      expect(json.data.role).toBe('VIEWER');

      // Now strangerUser is a member of organizationId!
      const verifyRes = await app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${organizationId}`,
        headers: { authorization: `Bearer ${strangerToken}` }
      });
      expect(verifyRes.statusCode).toBe(200);
    });

    it('allows member to leave organization (POST /organizations/:id/leave)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${organizationId}/leave`,
        headers: { authorization: `Bearer ${strangerToken}` }
      });

      expect(res.statusCode).toBe(200);

      // Now strangerUser cannot access organization anymore
      const verifyRes = await app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${organizationId}`,
        headers: { authorization: `Bearer ${strangerToken}` }
      });
      expect(verifyRes.statusCode).toBe(403);
    });
  });
});
