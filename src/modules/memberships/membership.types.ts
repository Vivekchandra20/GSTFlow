import { MembershipRole } from '../authorization/permissions.js';

export type MembershipStatus = 'ACTIVE' | 'SUSPENDED';

export interface MembershipEntity {
  id: string;
  organizationId: string;
  userId: string;
  role: MembershipRole;
  status: MembershipStatus;
  joinedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemberListItem {
  membershipId: string;
  organizationId: string;
  userId: string;
  email: string;
  role: MembershipRole;
  status: MembershipStatus;
  joinedAt: Date;
}

export interface UpdateMemberRoleInput {
  role: MembershipRole;
}
