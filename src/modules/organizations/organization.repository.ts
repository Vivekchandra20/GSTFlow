import { PrismaClient, Prisma } from '@prisma/client';
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
  IAuthorizationRepository,
  ResolvedMembershipDetails
} from '../authorization/authorization.service.js';
import { runInTenantTransaction } from '../../repositories/prisma/tenant-context.js';

export interface CreateOrgWithOwnerData {
  id: string;
  name: string;
  slug: string;
  pan?: string | null;
  userId: string;
}

export interface CreateInvitationData {
  id: string;
  organizationId: string;
  email: string;
  normalizedEmail: string;
  role: MembershipRole;
  tokenHash: string;
  invitedByUserId?: string;
  expiresAt: Date;
}

export interface IOrganizationRepository extends IAuthorizationRepository {
  createOrganizationWithOwner(
    data: CreateOrgWithOwnerData
  ): Promise<{ organization: OrganizationEntity; membership: MembershipEntity }>;
  listUserOrganizations(userId: string): Promise<UserOrganizationItem[]>;
  getOrganizationById(organizationId: string, tx?: any): Promise<OrganizationEntity | null>;
  updateOrganization(
    organizationId: string,
    data: { name?: string; pan?: string },
    tx?: any
  ): Promise<OrganizationEntity>;
  listMembers(organizationId: string, tx?: any): Promise<MemberListItem[]>;
  getMemberByUserId(organizationId: string, userId: string, tx?: any): Promise<MembershipEntity | null>;
  countActiveOwners(organizationId: string, tx?: any): Promise<number>;
  updateMemberRole(
    organizationId: string,
    userId: string,
    newRole: MembershipRole,
    tx?: any
  ): Promise<MembershipEntity>;
  removeMember(organizationId: string, userId: string, tx?: any): Promise<void>;
  createInvitation(data: CreateInvitationData, tx?: any): Promise<InvitationEntity>;
  listInvitations(organizationId: string, tx?: any): Promise<InvitationListItem[]>;
  listPendingInvitationsByEmail(normalizedEmail: string, tx?: any): Promise<PendingInvitationItem[]>;
  findInvitationByTokenHash(tokenHash: string, tx?: any): Promise<InvitationEntity | null>;
  findInvitationByTokenHashForUpdate(tokenHash: string, tx: any): Promise<InvitationEntity | null>;
  findInvitationByIdForUpdate(invitationId: string, tx: any): Promise<InvitationEntity | null>;
  findActiveInvitationByEmail(
    organizationId: string,
    normalizedEmail: string,
    tx?: any
  ): Promise<InvitationEntity | null>;
  acceptInvitation(
    invitationId: string,
    organizationId: string,
    userId: string,
    role: MembershipRole,
    tx: any
  ): Promise<MembershipEntity>;
  revokeInvitation(organizationId: string, invitationId: string, tx?: any): Promise<void>;
  runInTenantTransaction<T>(organizationId: string, fn: (tx: any) => Promise<T>): Promise<T>;
  runInTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T>;
}

export class PrismaOrganizationRepository implements IOrganizationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public async createOrganizationWithOwner(
    data: CreateOrgWithOwnerData
  ): Promise<{ organization: OrganizationEntity; membership: MembershipEntity }> {
    return await this.prisma.$transaction(async (tx) => {
      // Set tenant context for the new organization so RLS allows creation
      await tx.$executeRaw`SELECT set_config('app.current_organization_id', ${data.id}, true)`;

      const org = await (tx as any).organization.create({
        data: {
          id: data.id,
          name: data.name,
          slug: data.slug,
          pan: data.pan || null,
          status: 'ACTIVE'
        }
      });

      const membership = await (tx as any).organizationMembership.create({
        data: {
          organizationId: data.id,
          userId: data.userId,
          role: 'OWNER',
          status: 'ACTIVE'
        }
      });

      return {
        organization: this.mapOrganization(org),
        membership: this.mapMembership(membership)
      };
    });
  }

  public async listUserOrganizations(userId: string): Promise<UserOrganizationItem[]> {
    try {
      const rows = await this.prisma.$queryRaw<any[]>`
        SELECT * FROM list_user_organizations(${userId}::uuid)
      `;

      return rows.map((r) => ({
        id: r.organization_id,
        name: r.organization_name,
        slug: r.organization_slug,
        status: r.organization_status as OrganizationStatus,
        membershipId: r.membership_id,
        role: r.membership_role as MembershipRole,
        membershipStatus: r.membership_status,
        joinedAt: r.joined_at
      }));
    } catch {
      // Direct query fallback
      const memberships = await (this.prisma as any).organizationMembership.findMany({
        where: {
          userId,
          status: 'ACTIVE',
          organization: { status: 'ACTIVE' }
        },
        include: { organization: true },
        orderBy: { createdAt: 'asc' }
      });

      return memberships.map((m: any) => ({
        id: m.organization.id,
        name: m.organization.name,
        slug: m.organization.slug,
        status: m.organization.status as OrganizationStatus,
        membershipId: m.id,
        role: m.role as MembershipRole,
        membershipStatus: m.status,
        joinedAt: m.joinedAt
      }));
    }
  }

  public async getUserMembershipDetails(
    userId: string,
    organizationId: string
  ): Promise<ResolvedMembershipDetails | null> {
    try {
      const rows = await this.prisma.$queryRaw<any[]>`
        SELECT * FROM get_user_membership(${userId}::uuid, ${organizationId}::uuid)
      `;

      if (rows.length === 0) return null;
      const r = rows[0];

      return {
        membershipId: r.membership_id,
        organizationId: r.organization_id,
        organizationName: r.organization_name,
        organizationSlug: r.organization_slug,
        organizationStatus: r.organization_status,
        userId: r.user_id,
        role: r.membership_role as MembershipRole,
        membershipStatus: r.membership_status
      };
    } catch {
      // Fallback
      const membership = await (this.prisma as any).organizationMembership.findFirst({
        where: { userId, organizationId },
        include: { organization: true }
      });

      if (!membership) return null;

      return {
        membershipId: membership.id,
        organizationId: membership.organizationId,
        organizationName: membership.organization.name,
        organizationSlug: membership.organization.slug,
        organizationStatus: membership.organization.status,
        userId: membership.userId,
        role: membership.role as MembershipRole,
        membershipStatus: membership.status
      };
    }
  }

  public async getOrganizationById(
    organizationId: string,
    tx?: any
  ): Promise<OrganizationEntity | null> {
    const client = tx || this.prisma;
    const org = await (client as any).organization.findUnique({
      where: { id: organizationId }
    });

    return org ? this.mapOrganization(org) : null;
  }

  public async updateOrganization(
    organizationId: string,
    data: { name?: string; pan?: string },
    tx?: any
  ): Promise<OrganizationEntity> {
    const client = tx || this.prisma;
    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.pan !== undefined) updateData.pan = data.pan;

    const org = await (client as any).organization.update({
      where: { id: organizationId },
      data: updateData
    });

    return this.mapOrganization(org);
  }

  public async listMembers(organizationId: string, tx?: any): Promise<MemberListItem[]> {
    const client = tx || this.prisma;
    const members = await (client as any).organizationMembership.findMany({
      where: { organizationId },
      include: { user: true },
      orderBy: { createdAt: 'asc' }
    });

    return members.map((m: any) => ({
      membershipId: m.id,
      organizationId: m.organizationId,
      userId: m.userId,
      email: m.user.email,
      role: m.role as MembershipRole,
      status: m.status as MembershipStatus,
      joinedAt: m.joinedAt
    }));
  }

  public async getMemberByUserId(
    organizationId: string,
    userId: string,
    tx?: any
  ): Promise<MembershipEntity | null> {
    const client = tx || this.prisma;
    const membership = await (client as any).organizationMembership.findFirst({
      where: { organizationId, userId }
    });

    return membership ? this.mapMembership(membership) : null;
  }

  public async countActiveOwners(organizationId: string, tx?: any): Promise<number> {
    const client = tx || this.prisma;

    // Use row lock if tx supports it to ensure serialized check
    if (tx?.$queryRaw) {
      const rows = await tx.$queryRaw<any[]>`
        SELECT id FROM organization_memberships 
        WHERE organization_id = ${organizationId}::uuid 
          AND role = 'OWNER'::"MembershipRole" 
          AND status = 'ACTIVE'::"MembershipStatus"
        FOR UPDATE
      `;
      return rows.length;
    }

    return await (client as any).organizationMembership.count({
      where: {
        organizationId,
        role: 'OWNER',
        status: 'ACTIVE'
      }
    });
  }

  public async updateMemberRole(
    organizationId: string,
    userId: string,
    newRole: MembershipRole,
    tx?: any
  ): Promise<MembershipEntity> {
    const client = tx || this.prisma;
    const updated = await (client as any).organizationMembership.update({
      where: {
        uq_org_membership_user: {
          organizationId,
          userId
        }
      },
      data: { role: newRole }
    });

    return this.mapMembership(updated);
  }

  public async removeMember(organizationId: string, userId: string, tx?: any): Promise<void> {
    const client = tx || this.prisma;
    await (client as any).organizationMembership.delete({
      where: {
        uq_org_membership_user: {
          organizationId,
          userId
        }
      }
    });
  }

  public async createInvitation(
    data: CreateInvitationData,
    tx?: any
  ): Promise<InvitationEntity> {
    const client = tx || this.prisma;
    const invitation = await (client as any).organizationInvitation.create({
      data: {
        id: data.id,
        organizationId: data.organizationId,
        email: data.email,
        normalizedEmail: data.normalizedEmail,
        role: data.role,
        tokenHash: data.tokenHash,
        invitedByUserId: data.invitedByUserId || null,
        expiresAt: data.expiresAt
      }
    });

    return this.mapInvitation(invitation);
  }

  public async listInvitations(
    organizationId: string,
    tx?: any
  ): Promise<InvitationListItem[]> {
    const client = tx || this.prisma;
    const invitations = await (client as any).organizationInvitation.findMany({
      where: {
        organizationId,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() }
      },
      orderBy: { createdAt: 'desc' }
    });

    return invitations.map((i: any) => ({
      id: i.id,
      organizationId: i.organizationId,
      email: i.email,
      role: i.role as MembershipRole,
      expiresAt: i.expiresAt,
      acceptedAt: i.acceptedAt,
      revokedAt: i.revokedAt,
      createdAt: i.createdAt
    }));
  }

  public async findInvitationByTokenHash(
    tokenHash: string,
    tx?: any
  ): Promise<InvitationEntity | null> {
    const client = tx || this.prisma;
    const invitation = await (client as any).organizationInvitation.findUnique({
      where: { tokenHash }
    });

    return invitation ? this.mapInvitation(invitation) : null;
  }

  public async findInvitationByTokenHashForUpdate(
    tokenHash: string,
    tx: any
  ): Promise<InvitationEntity | null> {
    const rows = await tx.$queryRaw<any[]>`
      SELECT * FROM resolve_invitation_by_token_hash(${tokenHash})
    `;

    if (rows.length === 0) return null;
    const r = rows[0];

    // Set tenant context for this organization inside the transaction so RLS permits locking
    await tx.$executeRaw`SELECT set_config('app.current_organization_id', ${r.organization_id}, true)`;

    const lockedRows = await tx.$queryRaw<any[]>`
      SELECT * FROM organization_invitations
      WHERE id = ${r.invitation_id}::uuid
      FOR UPDATE
    `;

    if (lockedRows.length === 0) return null;
    const locked = lockedRows[0];

    return {
      id: locked.id,
      organizationId: locked.organization_id,
      email: locked.email,
      normalizedEmail: locked.normalized_email,
      role: locked.role as MembershipRole,
      tokenHash: locked.token_hash,
      invitedByUserId: locked.invited_by_user_id,
      expiresAt: locked.expires_at,
      acceptedAt: locked.accepted_at,
      revokedAt: locked.revoked_at,
      createdAt: locked.created_at
    };
  }

  public async findInvitationByIdForUpdate(
    invitationId: string,
    tx: any
  ): Promise<InvitationEntity | null> {
    const rows = await tx.$queryRaw<any[]>`
      SELECT * FROM resolve_invitation_by_id(${invitationId}::uuid)
    `;

    if (rows.length === 0) return null;
    const r = rows[0];

    await tx.$executeRaw`SELECT set_config('app.current_organization_id', ${r.organization_id}, true)`;

    const lockedRows = await tx.$queryRaw<any[]>`
      SELECT * FROM organization_invitations
      WHERE id = ${r.invitation_id}::uuid
      FOR UPDATE
    `;

    if (lockedRows.length === 0) return null;
    const locked = lockedRows[0];

    return {
      id: locked.id,
      organizationId: locked.organization_id,
      email: locked.email,
      normalizedEmail: locked.normalized_email,
      role: locked.role as MembershipRole,
      tokenHash: locked.token_hash,
      invitedByUserId: locked.invited_by_user_id,
      expiresAt: locked.expires_at,
      acceptedAt: locked.accepted_at,
      revokedAt: locked.revoked_at,
      createdAt: locked.created_at
    };
  }

  public async listPendingInvitationsByEmail(
    normalizedEmail: string,
    tx?: any
  ): Promise<PendingInvitationItem[]> {
    const client = tx || this.prisma;
    const rows = await client.$queryRaw<any[]>`
      SELECT * FROM list_pending_invitations_by_email(${normalizedEmail})
    `;

    return rows.map((r: any) => ({
      id: r.invitation_id,
      organizationId: r.organization_id,
      organizationName: r.organization_name,
      organizationSlug: r.organization_slug,
      email: r.email,
      role: r.role as MembershipRole,
      invitedByUserId: r.invited_by_user_id,
      invitedByEmail: r.invited_by_email,
      expiresAt: r.expires_at,
      createdAt: r.created_at
    }));
  }

  public async findActiveInvitationByEmail(
    organizationId: string,
    normalizedEmail: string,
    tx?: any
  ): Promise<InvitationEntity | null> {
    const client = tx || this.prisma;
    const invitation = await (client as any).organizationInvitation.findFirst({
      where: {
        organizationId,
        normalizedEmail,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() }
      }
    });

    return invitation ? this.mapInvitation(invitation) : null;
  }

  public async acceptInvitation(
    invitationId: string,
    organizationId: string,
    userId: string,
    role: MembershipRole,
    tx: any
  ): Promise<MembershipEntity> {
    if (tx?.$executeRaw) {
      await tx.$executeRaw`SELECT set_config('app.current_organization_id', ${organizationId}, true)`;
    }

    // 1. Mark invitation accepted
    await (tx as any).organizationInvitation.update({
      where: { id: invitationId },
      data: { acceptedAt: new Date() }
    });

    // 2. Insert membership
    const membership = await (tx as any).organizationMembership.create({
      data: {
        organizationId,
        userId,
        role,
        status: 'ACTIVE'
      }
    });

    return this.mapMembership(membership);
  }

  public async revokeInvitation(
    organizationId: string,
    invitationId: string,
    tx?: any
  ): Promise<void> {
    const client = tx || this.prisma;
    await (client as any).organizationInvitation.update({
      where: { id: invitationId },
      data: { revokedAt: new Date() }
    });
  }

  public async runInTenantTransaction<T>(
    organizationId: string,
    fn: (tx: any) => Promise<T>
  ): Promise<T> {
    return await runInTenantTransaction(
      this.prisma,
      { organizationId },
      async (tx) => await fn(tx)
    );
  }

  public async runInTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    return await this.prisma.$transaction(async (tx) => await fn(tx));
  }

  private mapOrganization(row: any): OrganizationEntity {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      pan: row.pan,
      status: row.status,
      dataRetentionMonths: row.dataRetentionMonths ?? row.data_retention_months ?? 72,
      createdAt: row.createdAt ?? row.created_at,
      updatedAt: row.updatedAt ?? row.updated_at
    };
  }

  private mapMembership(row: any): MembershipEntity {
    return {
      id: row.id,
      organizationId: row.organizationId ?? row.organization_id,
      userId: row.userId ?? row.user_id,
      role: row.role as MembershipRole,
      status: row.status as MembershipStatus,
      joinedAt: row.joinedAt ?? row.joined_at,
      createdAt: row.createdAt ?? row.created_at,
      updatedAt: row.updatedAt ?? row.updated_at
    };
  }

  private mapInvitation(row: any): InvitationEntity {
    return {
      id: row.id,
      organizationId: row.organizationId ?? row.organization_id,
      email: row.email,
      normalizedEmail: row.normalizedEmail ?? row.normalized_email,
      role: row.role as MembershipRole,
      tokenHash: row.tokenHash ?? row.token_hash,
      invitedByUserId: row.invitedByUserId ?? row.invited_by_user_id,
      expiresAt: row.expiresAt ?? row.expires_at,
      acceptedAt: row.acceptedAt ?? row.accepted_at,
      revokedAt: row.revokedAt ?? row.revoked_at,
      createdAt: row.createdAt ?? row.created_at
    };
  }
}
