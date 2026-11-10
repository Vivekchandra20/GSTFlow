import crypto from 'crypto';
import {
  OrganizationEntity,
  UserOrganizationItem,
  OrganizationStatus
} from './organization.types.js';
import {
  MembershipEntity,
  MemberListItem,
  MembershipStatus
} from '../memberships/membership.types.js';
import {
  InvitationEntity,
  InvitationListItem,
  PendingInvitationItem
} from '../invitations/invitation.types.js';
import { MembershipRole } from '../authorization/permissions.js';
import {
  IOrganizationRepository,
  CreateOrgWithOwnerData,
  CreateInvitationData
} from './organization.repository.js';
import { ResolvedMembershipDetails } from '../authorization/authorization.service.js';

export class InMemoryOrganizationRepository implements IOrganizationRepository {
  public organizations: Map<string, OrganizationEntity> = new Map();
  public memberships: Map<string, MembershipEntity> = new Map();
  public invitations: Map<string, InvitationEntity> = new Map();
  public users: Map<string, { id: string; email: string }> = new Map();

  public async createOrganizationWithOwner(
    data: CreateOrgWithOwnerData
  ): Promise<{ organization: OrganizationEntity; membership: MembershipEntity }> {
    const org: OrganizationEntity = {
      id: data.id,
      name: data.name,
      slug: data.slug,
      pan: data.pan || null,
      status: 'ACTIVE',
      dataRetentionMonths: 72,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    this.organizations.set(org.id, org);

    const membership: MembershipEntity = {
      id: crypto.randomUUID(),
      organizationId: data.id,
      userId: data.userId,
      role: 'OWNER',
      status: 'ACTIVE',
      joinedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date()
    };
    this.memberships.set(`${data.id}:${data.userId}`, membership);

    return { organization: org, membership };
  }

  public async listUserOrganizations(userId: string): Promise<UserOrganizationItem[]> {
    const results: UserOrganizationItem[] = [];
    for (const m of this.memberships.values()) {
      if (m.userId === userId && m.status === 'ACTIVE') {
        const org = this.organizations.get(m.organizationId);
        if (org && org.status === 'ACTIVE') {
          results.push({
            id: org.id,
            name: org.name,
            slug: org.slug,
            status: org.status,
            membershipId: m.id,
            role: m.role,
            membershipStatus: m.status,
            joinedAt: m.joinedAt
          });
        }
      }
    }
    return results;
  }

  public async getUserMembershipDetails(
    userId: string,
    organizationId: string
  ): Promise<ResolvedMembershipDetails | null> {
    const m = this.memberships.get(`${organizationId}:${userId}`);
    if (!m) return null;
    const org = this.organizations.get(organizationId);
    if (!org) return null;

    return {
      membershipId: m.id,
      organizationId: m.organizationId,
      organizationName: org.name,
      organizationSlug: org.slug,
      organizationStatus: org.status,
      userId: m.userId,
      role: m.role,
      membershipStatus: m.status
    };
  }

  public async getOrganizationById(
    organizationId: string,
    _tx?: any
  ): Promise<OrganizationEntity | null> {
    return this.organizations.get(organizationId) || null;
  }

  public async updateOrganization(
    organizationId: string,
    data: { name?: string; pan?: string },
    _tx?: any
  ): Promise<OrganizationEntity> {
    const org = this.organizations.get(organizationId);
    if (!org) throw new Error(`Organization ${organizationId} not found`);
    if (data.name !== undefined) org.name = data.name;
    if (data.pan !== undefined) org.pan = data.pan;
    org.updatedAt = new Date();
    return org;
  }

  public async listMembers(organizationId: string, _tx?: any): Promise<MemberListItem[]> {
    const members: MemberListItem[] = [];
    for (const m of this.memberships.values()) {
      if (m.organizationId === organizationId) {
        const user = this.users.get(m.userId);
        members.push({
          membershipId: m.id,
          organizationId: m.organizationId,
          userId: m.userId,
          email: user?.email || `user-${m.userId}@example.com`,
          role: m.role,
          status: m.status,
          joinedAt: m.joinedAt
        });
      }
    }
    return members;
  }

  public async getMemberByUserId(
    organizationId: string,
    userId: string,
    _tx?: any
  ): Promise<MembershipEntity | null> {
    return this.memberships.get(`${organizationId}:${userId}`) || null;
  }

  public async countActiveOwners(organizationId: string, _tx?: any): Promise<number> {
    let count = 0;
    for (const m of this.memberships.values()) {
      if (m.organizationId === organizationId && m.role === 'OWNER' && m.status === 'ACTIVE') {
        count++;
      }
    }
    return count;
  }

  public async updateMemberRole(
    organizationId: string,
    userId: string,
    newRole: MembershipRole,
    _tx?: any
  ): Promise<MembershipEntity> {
    const m = this.memberships.get(`${organizationId}:${userId}`);
    if (!m) throw new Error(`Membership not found`);
    m.role = newRole;
    m.updatedAt = new Date();
    return m;
  }

  public async removeMember(organizationId: string, userId: string, _tx?: any): Promise<void> {
    this.memberships.delete(`${organizationId}:${userId}`);
  }

  public async createInvitation(
    data: CreateInvitationData,
    _tx?: any
  ): Promise<InvitationEntity> {
    const invitation: InvitationEntity = {
      id: data.id,
      organizationId: data.organizationId,
      email: data.email,
      normalizedEmail: data.normalizedEmail,
      role: data.role,
      tokenHash: data.tokenHash,
      invitedByUserId: data.invitedByUserId || null,
      expiresAt: data.expiresAt,
      acceptedAt: null,
      revokedAt: null,
      createdAt: new Date()
    };
    this.invitations.set(data.tokenHash, invitation);
    return invitation;
  }

  public async listInvitations(
    organizationId: string,
    _tx?: any
  ): Promise<InvitationListItem[]> {
    const results: InvitationListItem[] = [];
    const now = new Date();
    for (const i of this.invitations.values()) {
      if (
        i.organizationId === organizationId &&
        i.acceptedAt === null &&
        i.revokedAt === null &&
        i.expiresAt > now
      ) {
        results.push({
          id: i.id,
          organizationId: i.organizationId,
          email: i.email,
          role: i.role,
          expiresAt: i.expiresAt,
          acceptedAt: i.acceptedAt,
          revokedAt: i.revokedAt,
          createdAt: i.createdAt
        });
      }
    }
    return results;
  }

  public async findInvitationByTokenHash(
    tokenHash: string,
    _tx?: any
  ): Promise<InvitationEntity | null> {
    return this.invitations.get(tokenHash) || null;
  }

  public async findInvitationByTokenHashForUpdate(
    tokenHash: string,
    _tx: any
  ): Promise<InvitationEntity | null> {
    return this.findInvitationByTokenHash(tokenHash);
  }

  public async findInvitationByIdForUpdate(
    invitationId: string,
    _tx: any
  ): Promise<InvitationEntity | null> {
    for (const inv of this.invitations.values()) {
      if (inv.id === invitationId) {
        return inv;
      }
    }
    return null;
  }

  public async listPendingInvitationsByEmail(
    normalizedEmail: string,
    _tx?: any
  ): Promise<PendingInvitationItem[]> {
    const results: PendingInvitationItem[] = [];
    const now = new Date();
    const targetEmail = normalizedEmail.trim().toLowerCase();

    for (const inv of this.invitations.values()) {
      if (
        inv.normalizedEmail === targetEmail &&
        inv.acceptedAt === null &&
        inv.revokedAt === null &&
        inv.expiresAt > now
      ) {
        const org = this.organizations.get(inv.organizationId);
        results.push({
          id: inv.id,
          organizationId: inv.organizationId,
          organizationName: org?.name || 'Organization',
          organizationSlug: org?.slug,
          email: inv.email,
          role: inv.role,
          invitedByUserId: inv.invitedByUserId,
          invitedByEmail: null,
          expiresAt: inv.expiresAt,
          createdAt: inv.createdAt
        });
      }
    }

    return results;
  }

  public async findActiveInvitationByEmail(
    organizationId: string,
    normalizedEmail: string,
    _tx?: any
  ): Promise<InvitationEntity | null> {
    const now = new Date();
    for (const i of this.invitations.values()) {
      if (
        i.organizationId === organizationId &&
        i.normalizedEmail === normalizedEmail &&
        i.acceptedAt === null &&
        i.revokedAt === null &&
        i.expiresAt > now
      ) {
        return i;
      }
    }
    return null;
  }

  public async acceptInvitation(
    invitationId: string,
    organizationId: string,
    userId: string,
    role: MembershipRole,
    _tx: any
  ): Promise<MembershipEntity> {
    for (const inv of this.invitations.values()) {
      if (inv.id === invitationId) {
        inv.acceptedAt = new Date();
        break;
      }
    }

    const membership: MembershipEntity = {
      id: crypto.randomUUID(),
      organizationId,
      userId,
      role,
      status: 'ACTIVE',
      joinedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date()
    };
    this.memberships.set(`${organizationId}:${userId}`, membership);
    return membership;
  }

  public async revokeInvitation(
    _organizationId: string,
    invitationId: string,
    _tx?: any
  ): Promise<void> {
    for (const inv of this.invitations.values()) {
      if (inv.id === invitationId) {
        inv.revokedAt = new Date();
        break;
      }
    }
  }

  public async runInTenantTransaction<T>(
    _organizationId: string,
    fn: (tx: any) => Promise<T>
  ): Promise<T> {
    return await fn(this);
  }

  public async runInTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    return await fn(this);
  }

  public clear(): void {
    this.organizations.clear();
    this.memberships.clear();
    this.invitations.clear();
    this.users.clear();
  }
}
