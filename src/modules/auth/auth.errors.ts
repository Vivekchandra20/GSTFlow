export abstract class AuthError extends Error {
  public abstract readonly statusCode: number;
  public abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InvalidCredentialsError extends AuthError {
  public readonly statusCode = 401;
  public readonly code = 'INVALID_CREDENTIALS';

  constructor(message = 'Invalid email or password.') {
    super(message);
  }
}

export class EmailAlreadyExistsError extends AuthError {
  public readonly statusCode = 409;
  public readonly code = 'EMAIL_ALREADY_EXISTS';

  constructor(message = 'An account with this email address already exists.') {
    super(message);
  }
}

export class AccountDisabledError extends AuthError {
  public readonly statusCode = 403;
  public readonly code = 'ACCOUNT_DISABLED';

  constructor(message = 'This account has been disabled.') {
    super(message);
  }
}

export class InvalidAccessTokenError extends AuthError {
  public readonly statusCode = 401;
  public readonly code = 'INVALID_ACCESS_TOKEN';

  constructor(message = 'Invalid access token.') {
    super(message);
  }
}

export class AccessTokenExpiredError extends AuthError {
  public readonly statusCode = 401;
  public readonly code = 'ACCESS_TOKEN_EXPIRED';

  constructor(message = 'Access token has expired.') {
    super(message);
  }
}

export class InvalidRefreshTokenError extends AuthError {
  public readonly statusCode = 401;
  public readonly code = 'INVALID_REFRESH_TOKEN';

  constructor(message = 'Invalid or expired refresh token.') {
    super(message);
  }
}

export class RefreshTokenReusedError extends AuthError {
  public readonly statusCode = 401;
  public readonly code = 'REFRESH_TOKEN_REUSED';

  constructor(message = 'Refresh token reuse detected. All sessions in this token family have been revoked.') {
    super(message);
  }
}

export class UnauthenticatedError extends AuthError {
  public readonly statusCode = 401;
  public readonly code = 'UNAUTHENTICATED';

  constructor(message = 'Authentication required.') {
    super(message);
  }
}

export class UserNotFoundError extends AuthError {
  public readonly statusCode = 404;
  public readonly code = 'USER_NOT_FOUND';

  constructor(message = 'User not found.') {
    super(message);
  }
}
