import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import {
  IOrganizationRepository,
  PrismaOrganizationRepository
} from './organization.repository.js';
import { InMemoryOrganizationRepository } from './in-memory-organization.repository.js';
import { OrganizationService } from './organization.service.js';
import { MembershipService } from '../memberships/membership.service.js';
import { InvitationService } from '../invitations/invitation.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { OrganizationController } from './organization.controller.js';
import {
  createRequireOrganizationPermission,
  createRequireOrganizationRole
} from '../authorization/authorization.hooks.js';
import {
  CreateOrganizationBodySchema,
  UpdateOrganizationBodySchema,
  UpdateMemberRoleBodySchema,
  CreateInvitationBodySchema,
  AcceptInvitationBodySchema
} from './organization.schemas.js';

declare module 'fastify' {
  interface FastifyInstance {
    organizationRepository?: IOrganizationRepository;
  }
}

export interface OrganizationRoutesOptions {
  organizationRepository?: IOrganizationRepository;
}

export const organizationRoutes: FastifyPluginAsync<OrganizationRoutesOptions> = async (
  fastify: FastifyInstance,
  options: OrganizationRoutesOptions
) => {
  let orgRepo = options.organizationRepository || fastify.organizationRepository;
  if (!orgRepo) {
    if (fastify.prisma) {
      orgRepo = new PrismaOrganizationRepository(fastify.prisma);
    } else {
      orgRepo = new InMemoryOrganizationRepository();
    }
  }

  const orgService = new OrganizationService(orgRepo);
  const memberService = new MembershipService(orgRepo);
  const invitationService = new InvitationService(orgRepo);
  const authzService = new AuthorizationService(orgRepo);

  const controller = new OrganizationController(orgService, memberService, invitationService);
  const requirePermission = createRequireOrganizationPermission(authzService);
  const requireRole = createRequireOrganizationRole(authzService, [
    'OWNER',
    'ADMIN',
    'MEMBER',
    'VIEWER'
  ]);

  // 1. POST /api/v1/organizations (Create organization)
  fastify.post(
    '/',
    {
      preHandler: [fastify.authenticate],
      schema: { body: CreateOrganizationBodySchema }
    },
    controller.createOrganization
  );

  // 2. GET /api/v1/organizations (List user's organizations)
  fastify.get(
    '/',
    {
      preHandler: [fastify.authenticate]
    },
    controller.listUserOrganizations
  );

  // 3. GET /api/v1/organizations/:organizationId (Get organization details)
  fastify.get(
    '/:organizationId',
    {
      preHandler: [fastify.authenticate, requirePermission('organization:read')]
    },
    controller.getOrganization
  );

  // 4. PATCH /api/v1/organizations/:organizationId (Update organization)
  fastify.patch(
    '/:organizationId',
    {
      preHandler: [fastify.authenticate, requirePermission('organization:update')],
      schema: { body: UpdateOrganizationBodySchema }
    },
    controller.updateOrganization
  );

  // 5. GET /api/v1/organizations/:organizationId/members (List members)
  fastify.get(
    '/:organizationId/members',
    {
      preHandler: [fastify.authenticate, requirePermission('members:read')]
    },
    controller.listMembers
  );

  // 6. PATCH /api/v1/organizations/:organizationId/members/:userId (Update member role)
  fastify.patch(
    '/:organizationId/members/:userId',
    {
      preHandler: [fastify.authenticate, requirePermission('members:update')],
      schema: { body: UpdateMemberRoleBodySchema }
    },
    controller.updateMemberRole
  );

  // 7. DELETE /api/v1/organizations/:organizationId/members/:userId (Remove member)
  fastify.delete(
    '/:organizationId/members/:userId',
    {
      preHandler: [fastify.authenticate, requirePermission('members:remove')]
    },
    controller.removeMember
  );

  // 8. POST /api/v1/organizations/:organizationId/leave (Leave organization)
  fastify.post(
    '/:organizationId/leave',
    {
      preHandler: [fastify.authenticate, requireRole]
    },
    controller.leaveOrganization
  );

  // 9. POST /api/v1/organizations/:organizationId/invitations (Invite member)
  fastify.post(
    '/:organizationId/invitations',
    {
      preHandler: [fastify.authenticate, requirePermission('members:invite')],
      schema: { body: CreateInvitationBodySchema }
    },
    controller.createInvitation
  );

  // 10. GET /api/v1/organizations/:organizationId/invitations (List invitations)
  fastify.get(
    '/:organizationId/invitations',
    {
      preHandler: [fastify.authenticate, requirePermission('members:read')]
    },
    controller.listInvitations
  );

  // 11. DELETE /api/v1/organizations/:organizationId/invitations/:invitationId (Revoke invitation)
  fastify.delete(
    '/:organizationId/invitations/:invitationId',
    {
      preHandler: [fastify.authenticate, requirePermission('members:invite')]
    },
    controller.revokeInvitation
  );
};

export const invitationRoutes: FastifyPluginAsync<OrganizationRoutesOptions> = async (
  fastify: FastifyInstance,
  options: OrganizationRoutesOptions
) => {
  let orgRepo = options.organizationRepository || fastify.organizationRepository;
  if (!orgRepo) {
    if (fastify.prisma) {
      orgRepo = new PrismaOrganizationRepository(fastify.prisma);
    } else {
      orgRepo = new InMemoryOrganizationRepository();
    }
  }

  const orgService = new OrganizationService(orgRepo);
  const memberService = new MembershipService(orgRepo);
  const invitationService = new InvitationService(orgRepo);

  const controller = new OrganizationController(orgService, memberService, invitationService);

  // GET /api/v1/invitations/pending (List pending invitations for authenticated user)
  fastify.get(
    '/pending',
    {
      preHandler: [fastify.authenticate]
    },
    controller.listUserPendingInvitations
  );

  // POST /api/v1/invitations/accept (Accept invitation via token or invitationId)
  fastify.post(
    '/accept',
    {
      preHandler: [fastify.authenticate],
      schema: { body: AcceptInvitationBodySchema }
    },
    controller.acceptInvitation
  );

  // POST /api/v1/invitations/:invitationId/decline (Decline invitation)
  fastify.post(
    '/:invitationId/decline',
    {
      preHandler: [fastify.authenticate]
    },
    controller.declineInvitation
  );
};
