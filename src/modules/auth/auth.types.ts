export type UserStatus = 'ACTIVE' | 'DISABLED';

export interface UserEntity {
  id: string;
  email: string;
  normalizedEmail: string;
  passwordHash: string;
  status: UserStatus;
  emailVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SafeUser {
  id: string;
  email: string;
  status: UserStatus;
  emailVerified: boolean;
  createdAt: Date;
}

export interface RefreshSessionEntity {
  id: string;
  userId: string;
  tokenHash: string;
  tokenFamilyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedBySessionId: string | null;
  userAgent: string | null;
  ipAddress: string | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
}

export interface AccessTokenPayload {
  sub: string;
  type: 'access';
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  jti?: string;
}

export interface AuthenticatedUser {
  userId: string;
  email: string;
  status: UserStatus;
}

export interface AuthResult {
  user: SafeUser;
  tokens: AuthTokens;
}

export interface ClientMetadata {
  userAgent?: string;
  ipAddress?: string;
}
