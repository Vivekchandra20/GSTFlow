import { FastifyRequest, FastifyReply } from 'fastify';
import { AuthorizationService } from './authorization.service.js';
import { Permission, MembershipRole } from './permissions.js';
import { UnauthenticatedError } from '../auth/auth.errors.js';
import { InsufficientPermissionsError } from './authorization.errors.js';

export function createRequireOrganizationPermission(authorizationService: AuthorizationService) {
  return (permission: Permission) => {
    return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
      if (!request.user || !request.user.userId) {
        throw new UnauthenticatedError('Authentication required before organization authorization');
      }

      const params = request.params as any;
      const organizationId = params?.organizationId;

      if (!organizationId) {
        throw new Error('Route misconfiguration: :organizationId parameter missing in route');
      }

      const orgContext = await authorizationService.authorizeTenantAccess(
        request.user.userId,
        organizationId,
        permission
      );

      request.organization = orgContext;
    };
  };
}

export function createRequireOrganizationRole(
  authorizationService: AuthorizationService,
  allowedRoles: MembershipRole[]
) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!request.user || !request.user.userId) {
      throw new UnauthenticatedError('Authentication required before organization authorization');
    }

    const params = request.params as any;
    const organizationId = params?.organizationId;

    if (!organizationId) {
      throw new Error('Route misconfiguration: :organizationId parameter missing in route');
    }

    const orgContext = await authorizationService.authorizeTenantAccess(
      request.user.userId,
      organizationId
    );

    if (!allowedRoles.includes(orgContext.role)) {
      throw new InsufficientPermissionsError(
        `Required role in [${allowedRoles.join(', ')}], but current user role is '${orgContext.role}'.`
      );
    }

    request.organization = orgContext;
  };
}
