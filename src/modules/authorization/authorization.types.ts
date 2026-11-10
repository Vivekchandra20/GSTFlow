import { MembershipRole, Permission } from './permissions.js';

export interface OrganizationContext {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  membershipId: string;
  role: MembershipRole;
  permissions: Permission[];
}

declare module 'fastify' {
  interface FastifyRequest {
    organization?: OrganizationContext;
  }
}
