import { MembershipRole } from '../authorization/permissions.js';

export interface InvitationEntity {
  id: string;
  organizationId: string;
  email: string;
  normalizedEmail: string;
  role: MembershipRole;
  tokenHash: string;
  invitedByUserId: string | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface InvitationListItem {
  id: string;
  organizationId: string;
  email: string;
  role: MembershipRole;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface CreateInvitationInput {
  email: string;
  role: MembershipRole;
}

export interface InvitationResult {
  id: string;
  organizationId: string;
  email: string;
  role: MembershipRole;
  expiresAt: Date;
  invitationToken: string;
}

export interface AcceptedInvitationResult {
  organizationId: string;
  membershipId: string;
  role: MembershipRole;
}

export interface PendingInvitationItem {
  id: string;
  organizationId: string;
  organizationName: string;
  organizationSlug?: string;
  email: string;
  role: MembershipRole;
  invitedByUserId?: string | null;
  invitedByEmail?: string | null;
  expiresAt: Date;
  createdAt: Date;
}

export interface AcceptInvitationInput {
  token?: string;
  invitationId?: string;
}
