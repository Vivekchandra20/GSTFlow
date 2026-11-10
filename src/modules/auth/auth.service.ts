import crypto from 'crypto';
import { IAuthRepository } from './auth.repository.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';
import {
  UserEntity,
  SafeUser,
  AuthResult,
  AuthTokens,
  ClientMetadata
} from './auth.types.js';
import {
  EmailAlreadyExistsError,
  InvalidCredentialsError,
  AccountDisabledError,
  InvalidRefreshTokenError,
  RefreshTokenReusedError,
  UserNotFoundError
} from './auth.errors.js';
import { RegisterBody, LoginBody } from './auth.schemas.js';
import { getEnvConfig } from '../../config/env.js';
import { logger } from '../../utils/logger.js';

export class AuthService {
  private readonly refreshTtlSeconds: number;

  constructor(
    private readonly authRepository: IAuthRepository,
    private readonly passwordService: PasswordService = new PasswordService(),
    private readonly tokenService: TokenService = new TokenService()
  ) {
    const env = getEnvConfig();
    this.refreshTtlSeconds = env.REFRESH_TOKEN_TTL_SECONDS;
  }

  /**
   * Registers a new user with normalized email, Argon2id password hash, and initial auth tokens.
   */
  public async register(input: RegisterBody, clientMeta?: ClientMetadata): Promise<AuthResult> {
    const normalizedEmail = this.normalizeEmail(input.email);

    const existingUser = await this.authRepository.findUserByNormalizedEmail(normalizedEmail);
    if (existingUser) {
      throw new EmailAlreadyExistsError();
    }

    const passwordHash = await this.passwordService.hash(input.password);

    let user: UserEntity;
    try {
      user = await this.authRepository.createUser({
        email: input.email.trim(),
        normalizedEmail,
        passwordHash
      });
    } catch (err: any) {
      if (err.code === 'P2002' || err.message?.includes('Unique constraint failed')) {
        throw new EmailAlreadyExistsError();
      }
      throw err;
    }

    logger.info({
      event: 'USER_REGISTERED',
      userId: user.id
    }, 'User successfully registered.');

    const tokens = await this.issueTokens(user.id, crypto.randomUUID(), clientMeta);

    return {
      user: this.toSafeUser(user),
      tokens
    };
  }

  /**
   * Authenticates user credentials using constant-time comparison to resist timing and enumeration attacks.
   */
  public async login(input: LoginBody, clientMeta?: ClientMetadata): Promise<AuthResult> {
    const normalizedEmail = this.normalizeEmail(input.email);
    const user = await this.authRepository.findUserByNormalizedEmail(normalizedEmail);

    if (!user) {
      // Execute dummy password verification to maintain uniform timing
      await this.passwordService.verify(
        '$argon2id$v=19$m=65536,t=3,p=4$dummyhashdummyhashdummyhashdummyhash$dummyhashdummyhashdummyhashdummyhash',
        input.password
      );
      throw new InvalidCredentialsError();
    }

    const isValidPassword = await this.passwordService.verify(user.passwordHash, input.password);
    if (!isValidPassword) {
      throw new InvalidCredentialsError();
    }

    if (user.status === 'DISABLED') {
      logger.warn({
        event: 'DISABLED_USER_LOGIN_ATTEMPT',
        userId: user.id
      }, 'Login attempt for disabled user account.');
      throw new AccountDisabledError();
    }

    const tokenFamilyId = crypto.randomUUID();
    const tokens = await this.issueTokens(user.id, tokenFamilyId, clientMeta);

    logger.info({
      event: 'USER_LOGIN_SUCCESS',
      userId: user.id
    }, 'User successfully logged in.');

    return {
      user: this.toSafeUser(user),
      tokens
    };
  }

  /**
   * Rotates a refresh token inside an ACID transaction with pessimistic row locking.
   * If an already-rotated token is presented, detects compromise and revokes the entire token family.
   */
  public async refresh(rawRefreshToken: string, clientMeta?: ClientMetadata): Promise<AuthResult> {
    const tokenHash = this.tokenService.hashRefreshToken(rawRefreshToken);

    return await this.authRepository.runInTransaction(async (tx) => {
      // 1. Fetch session under lock to prevent concurrent refresh races
      const session = await this.authRepository.findRefreshSessionByTokenHashForUpdate(tokenHash, tx);

      if (!session) {
        throw new InvalidRefreshTokenError('Refresh token not recognized.');
      }

      // 2. Token Family Reuse Detection: If token was already revoked or replaced, revoke family immediately!
      if (session.revokedAt !== null || session.replacedBySessionId !== null) {
        logger.error({
          event: 'REFRESH_TOKEN_REUSE_DETECTED',
          sessionId: session.id,
          tokenFamilyId: session.tokenFamilyId,
          userId: session.userId
        }, 'Security Alert: Previously rotated refresh token reused. Revoking entire token family.');

        await this.authRepository.revokeTokenFamily(session.tokenFamilyId, tx);
        throw new RefreshTokenReusedError();
      }

      // 3. Expiration Check
      if (session.expiresAt <= new Date()) {
        await this.authRepository.revokeSession(session.id, tx);
        throw new InvalidRefreshTokenError('Refresh token has expired.');
      }

      // 4. Verify User Identity and Account Status
      const user = await this.authRepository.findUserById(session.userId);
      if (!user) {
        await this.authRepository.revokeSession(session.id, tx);
        throw new UserNotFoundError();
      }

      if (user.status === 'DISABLED') {
        await this.authRepository.revokeSession(session.id, tx);
        throw new AccountDisabledError();
      }

      // 5. Rotate Token Atomically
      const { rawToken: newRawRefreshToken, tokenHash: newTokenHash } =
        this.tokenService.generateRefreshToken();

      const newExpiresAt = new Date(Date.now() + this.refreshTtlSeconds * 1000);

      await this.authRepository.rotateRefreshSession(
        session.id,
        {
          userId: user.id,
          tokenHash: newTokenHash,
          tokenFamilyId: session.tokenFamilyId, // Stays in the same family
          expiresAt: newExpiresAt,
          userAgent: clientMeta?.userAgent,
          ipAddress: clientMeta?.ipAddress
        },
        tx
      );

      const { accessToken, expiresIn } = this.tokenService.signAccessToken(user.id);

      logger.info({
        event: 'REFRESH_TOKEN_ROTATED',
        userId: user.id,
        tokenFamilyId: session.tokenFamilyId
      }, 'Refresh token rotated successfully.');

      return {
        user: this.toSafeUser(user),
        tokens: {
          accessToken,
          refreshToken: newRawRefreshToken,
          expiresIn,
          tokenType: 'Bearer'
        }
      };
    });
  }

  /**
   * Revokes the active refresh session on logout. Safe and idempotent.
   */
  public async logout(rawRefreshToken?: string): Promise<void> {
    if (!rawRefreshToken) {
      return;
    }

    const tokenHash = this.tokenService.hashRefreshToken(rawRefreshToken);
    const session = await this.authRepository.findRefreshSessionByTokenHash(tokenHash);

    if (session && !session.revokedAt) {
      await this.authRepository.revokeSession(session.id);
      logger.info({
        event: 'USER_LOGOUT_SUCCESS',
        userId: session.userId,
        sessionId: session.id
      }, 'Refresh session revoked on user logout.');
    }
  }

  /**
   * Resolves safe user details for the authenticated user.
   */
  public async getCurrentUser(userId: string): Promise<SafeUser> {
    const user = await this.authRepository.findUserById(userId);
    if (!user) {
      throw new UserNotFoundError();
    }
    if (user.status === 'DISABLED') {
      throw new AccountDisabledError();
    }
    return this.toSafeUser(user);
  }

  private async issueTokens(
    userId: string,
    tokenFamilyId: string,
    clientMeta?: ClientMetadata
  ): Promise<AuthTokens> {
    const { rawToken, tokenHash } = this.tokenService.generateRefreshToken();
    const expiresAt = new Date(Date.now() + this.refreshTtlSeconds * 1000);

    await this.authRepository.createRefreshSession({
      userId,
      tokenHash,
      tokenFamilyId,
      expiresAt,
      userAgent: clientMeta?.userAgent,
      ipAddress: clientMeta?.ipAddress
    });

    const { accessToken, expiresIn } = this.tokenService.signAccessToken(userId);

    return {
      accessToken,
      refreshToken: rawToken,
      expiresIn,
      tokenType: 'Bearer'
    };
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  public toSafeUser(user: UserEntity): SafeUser {
    return {
      id: user.id,
      email: user.email,
      status: user.status,
      emailVerified: user.emailVerifiedAt !== null,
      createdAt: user.createdAt
    };
  }
}
