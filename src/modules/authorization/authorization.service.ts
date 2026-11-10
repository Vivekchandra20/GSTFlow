import { Permission, MembershipRole, hasPermission, getRolePermissions } from './permissions.js';
import { OrganizationContext } from './authorization.types.js';
import {
  NotOrganizationMemberError,
  MembershipSuspendedError,
  OrganizationNotFoundError,
  OrganizationSuspendedError,
  InsufficientPermissionsError
} from './authorization.errors.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ResolvedMembershipDetails {
  membershipId: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  organizationStatus: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
  userId: string;
  role: MembershipRole;
  membershipStatus: 'ACTIVE' | 'SUSPENDED';
}

export interface IAuthorizationRepository {
  getUserMembershipDetails(
    userId: string,
    organizationId: string
  ): Promise<ResolvedMembershipDetails | null>;
}

export class AuthorizationService {
  constructor(private readonly authRepo: IAuthorizationRepository) {}

  public async authorizeTenantAccess(
    userId: string,
    organizationId: string,
    requiredPermission?: Permission
  ): Promise<OrganizationContext> {
    if (!organizationId || !UUID_REGEX.test(organizationId)) {
      throw new NotOrganizationMemberError('Invalid organization identifier.');
    }

    const details = await this.authRepo.getUserMembershipDetails(userId, organizationId);

    if (!details) {
      throw new NotOrganizationMemberError();
    }

    if (details.membershipStatus === 'SUSPENDED') {
      throw new MembershipSuspendedError();
    }

    if (details.organizationStatus !== 'ACTIVE') {
      throw new OrganizationSuspendedError();
    }

    if (requiredPermission && !hasPermission(details.role, requiredPermission)) {
      throw new InsufficientPermissionsError(
        `Role '${details.role}' does not have permission '${requiredPermission}'.`
      );
    }

    return {
      organizationId: details.organizationId,
      organizationName: details.organizationName,
      organizationSlug: details.organizationSlug,
      membershipId: details.membershipId,
      role: details.role,
      permissions: getRolePermissions(details.role)
    };
  }
}
