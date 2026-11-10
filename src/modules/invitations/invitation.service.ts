import crypto from 'crypto';
import { IOrganizationRepository } from '../organizations/organization.repository.js';
import {
  CreateInvitationInput,
  InvitationResult,
  InvitationListItem,
  AcceptedInvitationResult,
  PendingInvitationItem,
  AcceptInvitationInput
} from './invitation.types.js';
import {
  CannotInviteOwnerError,
  AlreadyOrganizationMemberError,
  DuplicateActiveInvitationError,
  InvalidInvitationError,
  InvitationExpiredError,
  InvitationAlreadyAcceptedError,
  InvitationEmailMismatchError
} from '../authorization/authorization.errors.js';
import { logger } from '../../utils/logger.js';

export class InvitationService {
  constructor(private readonly orgRepo: IOrganizationRepository) {}

  public async createInvitation(
    organizationId: string,
    inviterUserId: string,
    input: CreateInvitationInput
  ): Promise<InvitationResult> {
    if (input.role === 'OWNER') {
      throw new CannotInviteOwnerError();
    }

    const normalizedEmail = input.email.trim().toLowerCase();

    return await this.orgRepo.runInTenantTransaction(organizationId, async (tx) => {
      // Check if duplicate active invitation already exists
      const existingInvitation = await this.orgRepo.findActiveInvitationByEmail(
        organizationId,
        normalizedEmail,
        tx
      );
      if (existingInvitation) {
        throw new DuplicateActiveInvitationError();
      }

      // Generate crypto token (256-bit random)
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = this.hashToken(rawToken);

      // 7 days expiration
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const id = crypto.randomUUID();

      const invitation = await this.orgRepo.createInvitation(
        {
          id,
          organizationId,
          email: input.email.trim(),
          normalizedEmail,
          role: input.role,
          tokenHash,
          invitedByUserId: inviterUserId,
          expiresAt
        },
        tx
      );

      logger.info({
        event: 'INVITATION_CREATED',
        organizationId,
        invitationId: invitation.id,
        role: invitation.role,
        invitedByUserId: inviterUserId
      }, 'Organization invitation successfully created.');

      return {
        id: invitation.id,
        organizationId: invitation.organizationId,
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt,
        invitationToken: rawToken
      };
    });
  }

  public async listInvitations(organizationId: string): Promise<InvitationListItem[]> {
    return await this.orgRepo.runInTenantTransaction(organizationId, async (tx) => {
      return await this.orgRepo.listInvitations(organizationId, tx);
    });
  }

  public async listPendingInvitationsForEmail(email: string): Promise<PendingInvitationItem[]> {
    const normalizedEmail = email.trim().toLowerCase();
    return await this.orgRepo.listPendingInvitationsByEmail(normalizedEmail);
  }

  public async acceptInvitation(
    target: string | AcceptInvitationInput,
    user: { userId: string; email: string }
  ): Promise<AcceptedInvitationResult> {
    const isToken = typeof target === 'string' || (typeof target === 'object' && !!target.token);
    const rawToken = typeof target === 'string' ? target : target.token;
    const invitationId = typeof target === 'object' ? target.invitationId : undefined;

    return await this.orgRepo.runInTransaction(async (tx) => {
      let invitation: any = null;
      if (isToken && rawToken) {
        const tokenHash = this.hashToken(rawToken);
        invitation = await this.orgRepo.findInvitationByTokenHashForUpdate(tokenHash, tx);
      } else if (invitationId) {
        invitation = await this.orgRepo.findInvitationByIdForUpdate(invitationId, tx);
      }

      if (!invitation || invitation.revokedAt !== null) {
        throw new InvalidInvitationError();
      }

      if (invitation.acceptedAt !== null) {
        throw new InvitationAlreadyAcceptedError();
      }

      if (invitation.expiresAt <= new Date()) {
        throw new InvitationExpiredError();
      }

      // Verify email match: Authenticated user email must match invited email
      const userNormalizedEmail = user.email.trim().toLowerCase();
      if (userNormalizedEmail !== invitation.normalizedEmail) {
        throw new InvitationEmailMismatchError(
          `This invitation was sent to '${invitation.email}', but you are signed in as '${user.email}'.`
        );
      }

      // Check if user is already an active member
      const existingMembership = await this.orgRepo.getMemberByUserId(
        invitation.organizationId,
        user.userId,
        tx
      );
      if (existingMembership && existingMembership.status === 'ACTIVE') {
        throw new AlreadyOrganizationMemberError();
      }

      const membership = await this.orgRepo.acceptInvitation(
        invitation.id,
        invitation.organizationId,
        user.userId,
        invitation.role,
        tx
      );

      logger.info({
        event: 'INVITATION_ACCEPTED',
        organizationId: invitation.organizationId,
        invitationId: invitation.id,
        userId: user.userId,
        role: invitation.role
      }, 'Invitation accepted and organization membership created.');

      return {
        organizationId: invitation.organizationId,
        membershipId: membership.id,
        role: membership.role
      };
    });
  }

  public async declineInvitation(
    invitationId: string,
    user: { userId: string; email: string }
  ): Promise<void> {
    return await this.orgRepo.runInTransaction(async (tx) => {
      const invitation = await this.orgRepo.findInvitationByIdForUpdate(invitationId, tx);

      if (!invitation || invitation.revokedAt !== null) {
        throw new InvalidInvitationError();
      }

      if (invitation.acceptedAt !== null) {
        throw new InvitationAlreadyAcceptedError();
      }

      if (invitation.expiresAt <= new Date()) {
        throw new InvitationExpiredError();
      }

      const userNormalizedEmail = user.email.trim().toLowerCase();
      if (userNormalizedEmail !== invitation.normalizedEmail) {
        throw new InvitationEmailMismatchError(
          `This invitation was sent to '${invitation.email}', but you are signed in as '${user.email}'.`
        );
      }

      await this.orgRepo.revokeInvitation(invitation.organizationId, invitation.id, tx);

      logger.info({
        event: 'INVITATION_DECLINED',
        organizationId: invitation.organizationId,
        invitationId: invitation.id,
        userId: user.userId
      }, 'Invitation declined by invitee.');
    });
  }

  public async revokeInvitation(
    organizationId: string,
    invitationId: string
  ): Promise<void> {
    await this.orgRepo.runInTenantTransaction(organizationId, async (tx) => {
      await this.orgRepo.revokeInvitation(organizationId, invitationId, tx);
    });

    logger.info({
      event: 'INVITATION_REVOKED',
      organizationId,
      invitationId
    }, 'Invitation revoked.');
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }
}
