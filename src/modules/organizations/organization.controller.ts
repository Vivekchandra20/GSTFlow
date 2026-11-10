import { FastifyRequest, FastifyReply } from 'fastify';
import { OrganizationService } from './organization.service.js';
import { MembershipService } from '../memberships/membership.service.js';
import { InvitationService } from '../invitations/invitation.service.js';
import {
  CreateOrganizationBody,
  UpdateOrganizationBody,
  UpdateMemberRoleBody,
  CreateInvitationBody,
  AcceptInvitationBody
} from './organization.schemas.js';
import { UnauthenticatedError } from '../auth/auth.errors.js';

export class OrganizationController {
  constructor(
    private readonly orgService: OrganizationService,
    private readonly memberService: MembershipService,
    private readonly invitationService: InvitationService
  ) {}

  public createOrganization = async (
    request: FastifyRequest<any>,
    reply: FastifyReply
  ): Promise<void> => {
    if (!request.user || !request.user.userId) {
      throw new UnauthenticatedError();
    }

    const body = request.body as CreateOrganizationBody;
    const result = await this.orgService.createOrganization(request.user.userId, body);

    reply.status(201).send({
      success: true,
      data: result
    });
  };

  public listUserOrganizations = async (
    request: FastifyRequest<any>,
    reply: FastifyReply
  ): Promise<void> => {
    if (!request.user || !request.user.userId) {
      throw new UnauthenticatedError();
    }

    const organizations = await this.orgService.listUserOrganizations(request.user.userId);

    reply.status(200).send({
      success: true,
      data: {
        organizations
      }
    });
  };

  public getOrganization = async (
    request: FastifyRequest<any>,
    reply: FastifyReply
  ): Promise<void> => {
    const { organizationId } = request.params as { organizationId: string };
    const organization = await this.orgService.getOrganization(organizationId);

    reply.status(200).send({
      success: true,
      data: {
        organization
      }
    });
  };

  public updateOrganization = async (
    request: FastifyRequest<any>,
    reply: FastifyReply
  ): Promise<void> => {
    const { organizationId } = request.params as { organizationId: string };
    const body = request.body as UpdateOrganizationBody;
    const organization = await this.orgService.updateOrganization(organizationId, body);

    reply.status(200).send({
      success: true,
      data: {
        organization
      }
    });
  };

  public listMembers = async (
    request: FastifyRequest<any>,
    reply: FastifyReply
  ): Promise<void> => {
    const { organizationId } = request.params as { organizationId: string };
    const members = await this.memberService.listMembers(organizationId);

    reply.status(200).send({
      success: true,
      data: {
        members
      }
    });
  };

  public updateMemberRole = async (
    request: FastifyRequest<any>,
    reply: FastifyReply
  ): Promise<void> => {
    const { organizationId, userId: targetUserId } = request.params as {
      organizationId: string;
      userId: string;
    };
    const body = request.body as UpdateMemberRoleBody;
    const actorUserId = request.user!.userId;
    const actorRole = request.organization!.role;

    const membership = await this.memberService.updateMemberRole(
      organizationId,
      targetUserId,
      body.role,
      actorUserId,
      actorRole
    );

    reply.status(200).send({
      success: true,
      data: {
        membership
      }
    });
  };

  public removeMember = async (
    request: FastifyRequest<any>,
    reply: FastifyReply
  ): Promise<void> => {
    const { organizationId, userId: targetUserId } = request.params as {
      organizationId: string;
      userId: string;
    };
    const actorUserId = request.user!.userId;
    const actorRole = request.organization!.role;

    await this.memberService.removeMember(organizationId, targetUserId, actorUserId, actorRole);

    reply.status(200).send({
      success: true,
      data: {
        message: 'Member removed successfully'
      }
    });
  };

  public leaveOrganization = async (
    request: FastifyRequest<any>,
    reply: FastifyReply
  ): Promise<void> => {
    const { organizationId } = request.params as { organizationId: string };
    const userId = request.user!.userId;

    await this.memberService.leaveOrganization(organizationId, userId);

    reply.status(200).send({
      success: true,
      data: {
        message: 'Successfully left organization'
      }
    });
  };

  public createInvitation = async (
    request: FastifyRequest<any>,
    reply: FastifyReply
  ): Promise<void> => {
    const { organizationId } = request.params as { organizationId: string };
    const body = request.body as CreateInvitationBody;
    const inviterUserId = request.user!.userId;

    const result = await this.invitationService.createInvitation(
      organizationId,
      inviterUserId,
      body
    );

    reply.status(201).send({
      success: true,
      data: result
    });
  };

  public listInvitations = async (
    request: FastifyRequest<any>,
    reply: FastifyReply
  ): Promise<void> => {
    const { organizationId } = request.params as { organizationId: string };
    const invitations = await this.invitationService.listInvitations(organizationId);

    reply.status(200).send({
      success: true,
      data: {
        invitations
      }
    });
  };

  public revokeInvitation = async (
    request: FastifyRequest<any>,
    reply: FastifyReply
  ): Promise<void> => {
    const { organizationId, invitationId } = request.params as {
      organizationId: string;
      invitationId: string;
    };
    await this.invitationService.revokeInvitation(organizationId, invitationId);

    reply.status(200).send({
      success: true,
      data: {
        message: 'Invitation revoked successfully'
      }
    });
  };

  public listUserPendingInvitations = async (
    request: FastifyRequest<any>,
    reply: FastifyReply
  ): Promise<void> => {
    if (!request.user || !request.user.email) {
      throw new UnauthenticatedError();
    }

    const invitations = await this.invitationService.listPendingInvitationsForEmail(request.user.email);

    reply.status(200).send({
      success: true,
      data: {
        invitations
      }
    });
  };

  public acceptInvitation = async (
    request: FastifyRequest<any>,
    reply: FastifyReply
  ): Promise<void> => {
    if (!request.user || !request.user.userId || !request.user.email) {
      throw new UnauthenticatedError();
    }

    const body = request.body as AcceptInvitationBody;
    const result = await this.invitationService.acceptInvitation(body, {
      userId: request.user.userId,
      email: request.user.email
    });

    reply.status(200).send({
      success: true,
      data: result
    });
  };

  public declineInvitation = async (
    request: FastifyRequest<any>,
    reply: FastifyReply
  ): Promise<void> => {
    if (!request.user || !request.user.userId || !request.user.email) {
      throw new UnauthenticatedError();
    }

    const { invitationId } = request.params as { invitationId: string };
    await this.invitationService.declineInvitation(invitationId, {
      userId: request.user.userId,
      email: request.user.email
    });

    reply.status(200).send({
      success: true,
      data: {
        message: 'Invitation declined successfully'
      }
    });
  };
}
