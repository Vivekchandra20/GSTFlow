import { describe, it, expect, beforeEach } from 'vitest';
import { InvitationService } from '../../../src/modules/invitations/invitation.service.js';
import { InMemoryOrganizationRepository } from '../../../src/modules/organizations/in-memory-organization.repository.js';
import {
  CannotInviteOwnerError,
  AlreadyOrganizationMemberError,
  DuplicateActiveInvitationError,
  InvalidInvitationError,
  InvitationExpiredError,
  InvitationAlreadyAcceptedError,
  InvitationEmailMismatchError
} from '../../../src/modules/authorization/authorization.errors.js';

describe('InvitationService (Unit Suite)', () => {
  let orgRepo: InMemoryOrganizationRepository;
  let invitationService: InvitationService;

  const orgId = '11111111-2222-3333-4444-555555555555';
  const inviterId = 'aaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const targetUser = {
    userId: '99999999-8888-7777-6666-555555555555',
    email: 'newjoiner@example.com'
  };

  beforeEach(() => {
    orgRepo = new InMemoryOrganizationRepository();
    invitationService = new InvitationService(orgRepo);
  });

  describe('createInvitation', () => {
    it('creates an invitation with secure random token and SHA-256 hash', async () => {
      const result = await invitationService.createInvitation(orgId, inviterId, {
        email: '  NewJoiner@Example.COM  ',
        role: 'MEMBER'
      });

      expect(result.id).toBeDefined();
      expect(result.organizationId).toBe(orgId);
      expect(result.email).toBe('NewJoiner@Example.COM');
      expect(result.role).toBe('MEMBER');
      expect(result.invitationToken).toBeDefined();
      expect(result.invitationToken.length).toBe(64); // 32 bytes hex = 64 chars

      // Verify that database does NOT store the raw token
      expect(orgRepo.invitations.has(result.invitationToken)).toBe(false);
    });

    it('rejects invitations for OWNER role', async () => {
      await expect(
        invitationService.createInvitation(orgId, inviterId, {
          email: 'boss@example.com',
          role: 'OWNER'
        })
      ).rejects.toThrow(CannotInviteOwnerError);
    });

    it('rejects duplicate active invitation for the same email', async () => {
      await invitationService.createInvitation(orgId, inviterId, {
        email: 'duplicate@example.com',
        role: 'MEMBER'
      });

      await expect(
        invitationService.createInvitation(orgId, inviterId, {
          email: 'DUPLICATE@example.com',
          role: 'ADMIN'
        })
      ).rejects.toThrow(DuplicateActiveInvitationError);
    });
  });

  describe('acceptInvitation', () => {
    it('successfully accepts valid invitation matching authenticated user email', async () => {
      const invite = await invitationService.createInvitation(orgId, inviterId, {
        email: 'newjoiner@example.com',
        role: 'MEMBER'
      });

      const accepted = await invitationService.acceptInvitation(
        invite.invitationToken,
        targetUser
      );

      expect(accepted.organizationId).toBe(orgId);
      expect(accepted.role).toBe('MEMBER');
      expect(accepted.membershipId).toBeDefined();

      // Verify membership is in repository
      const member = await orgRepo.getMemberByUserId(orgId, targetUser.userId);
      expect(member).toBeDefined();
      expect(member?.role).toBe('MEMBER');
      expect(member?.status).toBe('ACTIVE');
    });

    it('rejects acceptance if user email does not match invitation recipient', async () => {
      const invite = await invitationService.createInvitation(orgId, inviterId, {
        email: 'target@example.com',
        role: 'MEMBER'
      });

      await expect(
        invitationService.acceptInvitation(invite.invitationToken, {
          userId: 'some-other-id',
          email: 'attacker@example.com'
        })
      ).rejects.toThrow(InvitationEmailMismatchError);
    });

    it('rejects re-acceptance of an already accepted invitation', async () => {
      const invite = await invitationService.createInvitation(orgId, inviterId, {
        email: 'newjoiner@example.com',
        role: 'MEMBER'
      });

      await invitationService.acceptInvitation(invite.invitationToken, targetUser);

      await expect(
        invitationService.acceptInvitation(invite.invitationToken, targetUser)
      ).rejects.toThrow(InvitationAlreadyAcceptedError);
    });

    it('rejects acceptance of an expired invitation', async () => {
      const invite = await invitationService.createInvitation(orgId, inviterId, {
        email: 'newjoiner@example.com',
        role: 'MEMBER'
      });

      // Artificially expire the invitation in repo
      for (const inv of orgRepo.invitations.values()) {
        inv.expiresAt = new Date(Date.now() - 1000);
      }

      await expect(
        invitationService.acceptInvitation(invite.invitationToken, targetUser)
      ).rejects.toThrow(InvitationExpiredError);
    });

    it('rejects acceptance of a revoked invitation', async () => {
      const invite = await invitationService.createInvitation(orgId, inviterId, {
        email: 'newjoiner@example.com',
        role: 'MEMBER'
      });

      await invitationService.revokeInvitation(orgId, invite.id);

      await expect(
        invitationService.acceptInvitation(invite.invitationToken, targetUser)
      ).rejects.toThrow(InvalidInvitationError);
    });

    it('successfully accepts invitation using invitationId without exposing raw token', async () => {
      const invite = await invitationService.createInvitation(orgId, inviterId, {
        email: 'newjoiner@example.com',
        role: 'ADMIN'
      });

      const accepted = await invitationService.acceptInvitation(
        { invitationId: invite.id },
        targetUser
      );

      expect(accepted.organizationId).toBe(orgId);
      expect(accepted.role).toBe('ADMIN');

      const member = await orgRepo.getMemberByUserId(orgId, targetUser.userId);
      expect(member).toBeDefined();
      expect(member?.role).toBe('ADMIN');
    });
  });

  describe('listPendingInvitationsForEmail', () => {
    it('returns pending invitations matching user email across organizations', async () => {
      await invitationService.createInvitation(orgId, inviterId, {
        email: 'NewJoiner@Example.com',
        role: 'MEMBER'
      });

      const secondOrgId = '22222222-3333-4444-5555-666666666666';
      await invitationService.createInvitation(secondOrgId, inviterId, {
        email: 'newjoiner@example.com',
        role: 'ADMIN'
      });

      const pending = await invitationService.listPendingInvitationsForEmail('newjoiner@example.com');
      expect(pending.length).toBe(2);
      expect(pending.map(p => p.organizationId)).toContain(orgId);
      expect(pending.map(p => p.organizationId)).toContain(secondOrgId);
      // Ensure raw token is not in the pending invitation items
      expect((pending[0] as any).invitationToken).toBeUndefined();
      expect((pending[0] as any).tokenHash).toBeUndefined();
    });
  });

  describe('declineInvitation', () => {
    it('successfully declines pending invitation', async () => {
      const invite = await invitationService.createInvitation(orgId, inviterId, {
        email: 'newjoiner@example.com',
        role: 'MEMBER'
      });

      await invitationService.declineInvitation(invite.id, targetUser);

      // Verify that after declining, it cannot be accepted
      await expect(
        invitationService.acceptInvitation({ invitationId: invite.id }, targetUser)
      ).rejects.toThrow(InvalidInvitationError);

      // Verify that it no longer appears in pending list
      const pending = await invitationService.listPendingInvitationsForEmail('newjoiner@example.com');
      expect(pending.find(p => p.id === invite.id)).toBeUndefined();
    });

    it('rejects decline when signed in as different email', async () => {
      const invite = await invitationService.createInvitation(orgId, inviterId, {
        email: 'newjoiner@example.com',
        role: 'MEMBER'
      });

      await expect(
        invitationService.declineInvitation(invite.id, {
          userId: 'other-id',
          email: 'stranger@example.com'
        })
      ).rejects.toThrow(InvitationEmailMismatchError);
    });
  });
});
