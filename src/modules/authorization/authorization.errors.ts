export abstract class AuthorizationError extends Error {
  public abstract readonly statusCode: number;
  public abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class NotOrganizationMemberError extends AuthorizationError {
  public readonly statusCode = 403;
  public readonly code = 'NOT_AN_ORGANIZATION_MEMBER';

  constructor(message = 'User is not a member of the requested organization.') {
    super(message);
  }
}

export class MembershipSuspendedError extends AuthorizationError {
  public readonly statusCode = 403;
  public readonly code = 'MEMBERSHIP_SUSPENDED';

  constructor(message = 'Organization membership is suspended.') {
    super(message);
  }
}

export class OrganizationNotFoundError extends AuthorizationError {
  public readonly statusCode = 404;
  public readonly code = 'ORGANIZATION_NOT_FOUND';

  constructor(message = 'Organization not found.') {
    super(message);
  }
}

export class OrganizationSuspendedError extends AuthorizationError {
  public readonly statusCode = 403;
  public readonly code = 'ORGANIZATION_SUSPENDED';

  constructor(message = 'Organization account is suspended or archived.') {
    super(message);
  }
}

export class InsufficientPermissionsError extends AuthorizationError {
  public readonly statusCode = 403;
  public readonly code = 'INSUFFICIENT_PERMISSIONS';

  constructor(message = 'User does not possess the required permission for this operation.') {
    super(message);
  }
}

export class CannotRemoveLastOwnerError extends AuthorizationError {
  public readonly statusCode = 400;
  public readonly code = 'CANNOT_REMOVE_LAST_OWNER';

  constructor(message = 'Cannot remove the last active owner of the organization.') {
    super(message);
  }
}

export class CannotDemoteLastOwnerError extends AuthorizationError {
  public readonly statusCode = 400;
  public readonly code = 'CANNOT_DEMOTE_LAST_OWNER';

  constructor(message = 'Cannot demote the last active owner of the organization.') {
    super(message);
  }
}

export class UnauthorizedRoleEscalationError extends AuthorizationError {
  public readonly statusCode = 403;
  public readonly code = 'UNAUTHORIZED_ROLE_ESCALATION';

  constructor(message = 'Users cannot assign or alter a role equal to or higher than their own authority.') {
    super(message);
  }
}

export class AlreadyOrganizationMemberError extends AuthorizationError {
  public readonly statusCode = 409;
  public readonly code = 'ALREADY_ORGANIZATION_MEMBER';

  constructor(message = 'The user is already an active member of this organization.') {
    super(message);
  }
}

export class DuplicateActiveInvitationError extends AuthorizationError {
  public readonly statusCode = 409;
  public readonly code = 'DUPLICATE_ACTIVE_INVITATION';

  constructor(message = 'An active pending invitation already exists for this email.') {
    super(message);
  }
}

export class CannotInviteOwnerError extends AuthorizationError {
  public readonly statusCode = 400;
  public readonly code = 'CANNOT_INVITE_OWNER';

  constructor(message = 'Invitations cannot grant the OWNER role. Existing owners can transfer ownership.') {
    super(message);
  }
}

export class InvalidInvitationError extends AuthorizationError {
  public readonly statusCode = 400;
  public readonly code = 'INVALID_INVITATION';

  constructor(message = 'Invalid invitation token or invitation not found.') {
    super(message);
  }
}

export class InvitationExpiredError extends AuthorizationError {
  public readonly statusCode = 400;
  public readonly code = 'INVITATION_EXPIRED';

  constructor(message = 'Invitation has expired.') {
    super(message);
  }
}

export class InvitationAlreadyAcceptedError extends AuthorizationError {
  public readonly statusCode = 400;
  public readonly code = 'INVITATION_ALREADY_ACCEPTED';

  constructor(message = 'Invitation has already been accepted.') {
    super(message);
  }
}

export class InvitationEmailMismatchError extends AuthorizationError {
  public readonly statusCode = 403;
  public readonly code = 'INVITATION_EMAIL_MISMATCH';

  constructor(message = 'Authenticated user email does not match the email address this invitation was issued to.') {
    super(message);
  }
}
