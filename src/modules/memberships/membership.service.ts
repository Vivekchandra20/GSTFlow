import { IOrganizationRepository } from '../organizations/organization.repository.js';
import { MemberListItem, MembershipEntity } from './membership.types.js';
import { MembershipRole, isRoleStrictlyHigher } from '../authorization/permissions.js';
import {
  NotOrganizationMemberError,
  CannotRemoveLastOwnerError,
  CannotDemoteLastOwnerError,
  UnauthorizedRoleEscalationError
} from '../authorization/authorization.errors.js';
import { logger } from '../../utils/logger.js';

export class MembershipService {
  constructor(private readonly orgRepo: IOrganizationRepository) {}

  public async listMembers(organizationId: string): Promise<MemberListItem[]> {
    return await this.orgRepo.listMembers(organizationId);
  }

  public async updateMemberRole(
    organizationId: string,
    targetUserId: string,
    newRole: MembershipRole,
    actorUserId: string,
    actorRole: MembershipRole
  ): Promise<MembershipEntity> {
    // 1. Role hierarchy checks
    // An actor cannot assign a role equal to or higher than their own (unless OWNER).
    if (actorRole !== 'OWNER' && !isRoleStrictlyHigher(actorRole, newRole)) {
      throw new UnauthorizedRoleEscalationError(
        `Role '${actorRole}' cannot assign role '${newRole}'.`
      );
    }

    return await this.orgRepo.runInTenantTransaction(organizationId, async (tx) => {
      const targetMembership = await this.orgRepo.getMemberByUserId(organizationId, targetUserId, tx);
      if (!targetMembership) {
        throw new NotOrganizationMemberError('Target user is not a member of this organization.');
      }

      // An actor cannot modify someone with equal or higher role (unless OWNER)
      if (actorRole !== 'OWNER' && !isRoleStrictlyHigher(actorRole, targetMembership.role)) {
        throw new UnauthorizedRoleEscalationError(
          `Cannot modify role of member with equal or higher role '${targetMembership.role}'.`
        );
      }

      // 2. Last Owner Protection: If target is currently OWNER and newRole is not OWNER
      if (targetMembership.role === 'OWNER' && newRole !== 'OWNER') {
        const ownerCount = await this.orgRepo.countActiveOwners(organizationId, tx);
        if (ownerCount <= 1) {
          throw new CannotDemoteLastOwnerError();
        }
      }

      const updated = await this.orgRepo.updateMemberRole(organizationId, targetUserId, newRole, tx);

      logger.info({
        event: 'MEMBER_ROLE_UPDATED',
        organizationId,
        targetUserId,
        previousRole: targetMembership.role,
        newRole,
        actorUserId
      }, 'Member role successfully updated.');

      return updated;
    });
  }

  public async removeMember(
    organizationId: string,
    targetUserId: string,
    actorUserId: string,
    actorRole: MembershipRole
  ): Promise<void> {
    await this.orgRepo.runInTenantTransaction(organizationId, async (tx) => {
      const targetMembership = await this.orgRepo.getMemberByUserId(organizationId, targetUserId, tx);
      if (!targetMembership) {
        throw new NotOrganizationMemberError('Target user is not a member of this organization.');
      }

      // Actor cannot remove someone of higher or equal role (unless OWNER)
      if (actorRole !== 'OWNER' && !isRoleStrictlyHigher(actorRole, targetMembership.role)) {
        throw new UnauthorizedRoleEscalationError(
          `Cannot remove member with equal or higher role '${targetMembership.role}'.`
        );
      }

      // Last Owner Protection
      if (targetMembership.role === 'OWNER') {
        const ownerCount = await this.orgRepo.countActiveOwners(organizationId, tx);
        if (ownerCount <= 1) {
          throw new CannotRemoveLastOwnerError();
        }
      }

      await this.orgRepo.removeMember(organizationId, targetUserId, tx);

      logger.info({
        event: 'MEMBER_REMOVED',
        organizationId,
        targetUserId,
        actorUserId
      }, 'Member removed from organization.');
    });
  }

  public async leaveOrganization(organizationId: string, userId: string): Promise<void> {
    await this.orgRepo.runInTenantTransaction(organizationId, async (tx) => {
      const membership = await this.orgRepo.getMemberByUserId(organizationId, userId, tx);
      if (!membership) {
        throw new NotOrganizationMemberError('User is not a member of this organization.');
      }

      // If user is OWNER, ensure they are not the last active OWNER
      if (membership.role === 'OWNER') {
        const ownerCount = await this.orgRepo.countActiveOwners(organizationId, tx);
        if (ownerCount <= 1) {
          throw new CannotRemoveLastOwnerError(
            'Cannot leave organization as the sole active OWNER. Transfer ownership before leaving.'
          );
        }
      }

      await this.orgRepo.removeMember(organizationId, userId, tx);

      logger.info({
        event: 'MEMBER_LEFT_ORGANIZATION',
        organizationId,
        userId
      }, 'User left the organization.');
    });
  }
}
