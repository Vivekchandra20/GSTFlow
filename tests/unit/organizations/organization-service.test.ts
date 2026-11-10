import { describe, it, expect, beforeEach } from 'vitest';
import { OrganizationService } from '../../../src/modules/organizations/organization.service.js';
import { MembershipService } from '../../../src/modules/memberships/membership.service.js';
import { InMemoryOrganizationRepository } from '../../../src/modules/organizations/in-memory-organization.repository.js';
import {
  CannotDemoteLastOwnerError,
  CannotRemoveLastOwnerError,
  UnauthorizedRoleEscalationError,
  OrganizationNotFoundError
} from '../../../src/modules/authorization/authorization.errors.js';

describe('Organization & Membership Services (Unit Suite)', () => {
  let orgRepo: InMemoryOrganizationRepository;
  let orgService: OrganizationService;
  let memberService: MembershipService;

  const userOwner = '11111111-1111-4000-8000-000000000001';
  const userAdmin = '22222222-2222-4000-8000-000000000002';
  const userMember = '33333333-3333-4000-8000-000000000003';

  beforeEach(() => {
    orgRepo = new InMemoryOrganizationRepository();
    orgService = new OrganizationService(orgRepo);
    memberService = new MembershipService(orgRepo);

    orgRepo.users.set(userOwner, { id: userOwner, email: 'owner@example.com' });
    orgRepo.users.set(userAdmin, { id: userAdmin, email: 'admin@example.com' });
    orgRepo.users.set(userMember, { id: userMember, email: 'member@example.com' });
  });

  describe('Organization Creation & Listing', () => {
    it('creates an organization and automatically assigns creator as OWNER', async () => {
      const result = await orgService.createOrganization(userOwner, {
        name: 'Acme Tax Corp',
        pan: 'ABCDE1234F'
      });

      expect(result.organization.id).toBeDefined();
      expect(result.organization.name).toBe('Acme Tax Corp');
      expect(result.organization.slug).toBeDefined();
      expect(result.organization.status).toBe('ACTIVE');
      expect(result.membership.role).toBe('OWNER');
      expect(result.membership.userId).toBe(userOwner);

      // Verify listing for this user
      const orgs = await orgService.listUserOrganizations(userOwner);
      expect(orgs.length).toBe(1);
      expect(orgs[0].id).toBe(result.organization.id);
      expect(orgs[0].role).toBe('OWNER');

      // Verify another user sees 0 organizations
      const otherOrgs = await orgService.listUserOrganizations(userAdmin);
      expect(otherOrgs.length).toBe(0);
    });

    it('updates organization details successfully', async () => {
      const created = await orgService.createOrganization(userOwner, { name: 'Acme Old' });
      const updated = await orgService.updateOrganization(created.organization.id, {
        name: 'Acme Renovated',
        pan: 'XYZAB5678C'
      });

      expect(updated.name).toBe('Acme Renovated');
      expect(updated.pan).toBe('XYZAB5678C');
    });

    it('throws OrganizationNotFoundError when accessing non-existent organization', async () => {
      await expect(orgService.getOrganization('00000000-0000-0000-0000-000000000000')).rejects.toThrow(
        OrganizationNotFoundError
      );
    });
  });

  describe('Membership Role Management & Last-Owner Protection', () => {
    let orgId: string;

    beforeEach(async () => {
      const res = await orgService.createOrganization(userOwner, { name: 'Test Org' });
      orgId = res.organization.id;

      // Add Admin and Member manually to repo
      await orgRepo.acceptInvitation('dummy', orgId, userAdmin, 'ADMIN', null);
      await orgRepo.acceptInvitation('dummy', orgId, userMember, 'MEMBER', null);
    });

    it('allows OWNER to promote MEMBER to ADMIN', async () => {
      const updated = await memberService.updateMemberRole(
        orgId,
        userMember,
        'ADMIN',
        userOwner,
        'OWNER'
      );
      expect(updated.role).toBe('ADMIN');
    });

    it('prevents ADMIN from elevating someone to OWNER', async () => {
      await expect(
        memberService.updateMemberRole(orgId, userMember, 'OWNER', userAdmin, 'ADMIN')
      ).rejects.toThrow(UnauthorizedRoleEscalationError);
    });

    it('prevents demoting the sole active OWNER', async () => {
      await expect(
        memberService.updateMemberRole(orgId, userOwner, 'ADMIN', userOwner, 'OWNER')
      ).rejects.toThrow(CannotDemoteLastOwnerError);
    });

    it('prevents removing the sole active OWNER', async () => {
      await expect(
        memberService.removeMember(orgId, userOwner, userOwner, 'OWNER')
      ).rejects.toThrow(CannotRemoveLastOwnerError);
    });

    it('prevents the sole active OWNER from leaving the organization', async () => {
      await expect(memberService.leaveOrganization(orgId, userOwner)).rejects.toThrow(
        CannotRemoveLastOwnerError
      );
    });

    it('allows demoting/removing an owner when another active owner exists', async () => {
      // Add second owner
      const secondOwner = '44444444-4444-4000-8000-000000000004';
      await orgRepo.acceptInvitation('dummy', orgId, secondOwner, 'OWNER', null);

      // Now demoting userOwner succeeds
      const updated = await memberService.updateMemberRole(
        orgId,
        userOwner,
        'ADMIN',
        secondOwner,
        'OWNER'
      );
      expect(updated.role).toBe('ADMIN');
    });
  });
});
