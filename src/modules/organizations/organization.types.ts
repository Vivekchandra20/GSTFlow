import { MembershipRole } from '../authorization/permissions.js';

export type OrganizationStatus = 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';

export interface OrganizationEntity {
  id: string;
  name: string;
  slug: string;
  pan: string | null;
  status: OrganizationStatus;
  dataRetentionMonths: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserOrganizationItem {
  id: string;
  name: string;
  slug: string;
  status: OrganizationStatus;
  membershipId: string;
  role: MembershipRole;
  membershipStatus: string;
  joinedAt: Date;
}

export interface CreateOrganizationInput {
  name: string;
  slug?: string;
  pan?: string;
}

export interface UpdateOrganizationInput {
  name?: string;
  pan?: string;
}
