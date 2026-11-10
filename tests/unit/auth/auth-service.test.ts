import { describe, it, expect, beforeEach } from 'vitest';
import { AuthService } from '../../../src/modules/auth/auth.service.js';
import { InMemoryAuthRepository } from '../../../src/modules/auth/in-memory-auth.repository.js';
import { PasswordService } from '../../../src/modules/auth/password.service.js';
import { TokenService } from '../../../src/modules/auth/token.service.js';
import {
  EmailAlreadyExistsError,
  InvalidCredentialsError,
  AccountDisabledError,
  InvalidRefreshTokenError,
  RefreshTokenReusedError,
  UserNotFoundError
} from '../../../src/modules/auth/auth.errors.js';

describe('AuthService (Unit Suite)', () => {
  let authRepository: InMemoryAuthRepository;
  let passwordService: PasswordService;
  let tokenService: TokenService;
  let authService: AuthService;

  beforeEach(() => {
    authRepository = new InMemoryAuthRepository();
    passwordService = new PasswordService();
    tokenService = new TokenService();
    authService = new AuthService(authRepository, passwordService, tokenService);
  });

  describe('register', () => {
    it('successfully registers a user with normalized email and password hash', async () => {
      const result = await authService.register({
        email: '  Alice.Tax@Example.COM  ',
        password: 'ValidPassword123'
      });

      expect(result.user).toBeDefined();
      expect(result.user.email).toBe('Alice.Tax@Example.COM');
      expect(result.user.status).toBe('ACTIVE');
      expect(result.tokens.accessToken).toBeDefined();
      expect(result.tokens.refreshToken).toBeDefined();
      expect(result.tokens.tokenType).toBe('Bearer');

      // Verify stored normalized email
      const stored = await authRepository.findUserByNormalizedEmail('alice.tax@example.com');
      expect(stored).toBeDefined();
      expect(stored?.passwordHash).not.toBe('ValidPassword123');
    });

    it('rejects registration if normalized email already exists', async () => {
      await authService.register({
        email: 'bob@example.com',
        password: 'Password123'
      });

      await expect(
        authService.register({
          email: 'BOB@EXAMPLE.COM',
          password: 'AnotherPassword456'
        })
      ).rejects.toThrow(EmailAlreadyExistsError);
    });
  });

  describe('login', () => {
    beforeEach(async () => {
      await authService.register({
        email: 'charlie@example.com',
        password: 'CharliePassword123'
      });
    });

    it('successfully logs in with valid credentials', async () => {
      const result = await authService.login({
        email: 'CHARLIE@example.com',
        password: 'CharliePassword123'
      });

      expect(result.user.email).toBe('charlie@example.com');
      expect(result.tokens.accessToken).toBeDefined();
      expect(result.tokens.refreshToken).toBeDefined();
    });

    it('rejects login with invalid password using constant-time check', async () => {
      await expect(
        authService.login({
          email: 'charlie@example.com',
          password: 'WrongPassword999'
        })
      ).rejects.toThrow(InvalidCredentialsError);
    });

    it('rejects login with non-existent user with identical error', async () => {
      await expect(
        authService.login({
          email: 'nonexistent@example.com',
          password: 'AnyPassword123'
        })
      ).rejects.toThrow(InvalidCredentialsError);
    });

    it('rejects login for disabled accounts', async () => {
      const user = await authRepository.findUserByNormalizedEmail('charlie@example.com');
      await authRepository.updateUserStatus(user!.id, 'DISABLED');

      await expect(
        authService.login({
          email: 'charlie@example.com',
          password: 'CharliePassword123'
        })
      ).rejects.toThrow(AccountDisabledError);
    });
  });

  describe('refresh token rotation & reuse detection', () => {
    it('successfully rotates refresh token and invalidates the previous token', async () => {
      const auth = await authService.register({
        email: 'david@example.com',
        password: 'DavidPassword123'
      });

      const initialRefreshToken = auth.tokens.refreshToken;

      // 1. First refresh
      const refreshed = await authService.refresh(initialRefreshToken);
      expect(refreshed.tokens.refreshToken).toBeDefined();
      expect(refreshed.tokens.refreshToken).not.toBe(initialRefreshToken);

      // Verify the old session is marked as replaced
      const oldHash = tokenService.hashRefreshToken(initialRefreshToken);
      const oldSession = await authRepository.findRefreshSessionByTokenHash(oldHash);
      expect(oldSession?.revokedAt).not.toBeNull();
      expect(oldSession?.replacedBySessionId).toBeDefined();

      // 2. Second refresh using the new token
      const secondRefresh = await authService.refresh(refreshed.tokens.refreshToken);
      expect(secondRefresh.tokens.refreshToken).not.toBe(refreshed.tokens.refreshToken);
    });

    it('detects token reuse and immediately revokes entire token family', async () => {
      const auth = await authService.register({
        email: 'eve@example.com',
        password: 'EvePassword123'
      });

      const stolenToken = auth.tokens.refreshToken;

      // Legitimate user rotates token:
      const legitimateRefresh = await authService.refresh(stolenToken);
      expect(legitimateRefresh.tokens.refreshToken).toBeDefined();

      // Attacker attempts to use stolen (now rotated) token:
      await expect(authService.refresh(stolenToken)).rejects.toThrow(RefreshTokenReusedError);

      // Verify all sessions in that family are now revoked:
      const newHash = tokenService.hashRefreshToken(legitimateRefresh.tokens.refreshToken);
      const activeSession = await authRepository.findRefreshSessionByTokenHash(newHash);
      expect(activeSession?.revokedAt).not.toBeNull();

      // Subsequent refresh with even the latest token must now fail:
      await expect(authService.refresh(legitimateRefresh.tokens.refreshToken)).rejects.toThrow(
        RefreshTokenReusedError
      );
    });

    it('rejects expired refresh token', async () => {
      const auth = await authService.register({
        email: 'frank@example.com',
        password: 'FrankPassword123'
      });

      const hash = tokenService.hashRefreshToken(auth.tokens.refreshToken);
      const session = await authRepository.findRefreshSessionByTokenHash(hash);

      // Artificially expire the session
      await authRepository.runInTransaction(async () => {
        session!.expiresAt = new Date(Date.now() - 10000);
      });

      await expect(authService.refresh(auth.tokens.refreshToken)).rejects.toThrow(
        InvalidRefreshTokenError
      );
    });
  });

  describe('logout', () => {
    it('revokes the refresh token session on logout', async () => {
      const auth = await authService.register({
        email: 'george@example.com',
        password: 'GeorgePassword123'
      });

      const rawToken = auth.tokens.refreshToken;
      await authService.logout(rawToken);

      const hash = tokenService.hashRefreshToken(rawToken);
      const session = await authRepository.findRefreshSessionByTokenHash(hash);
      expect(session?.revokedAt).not.toBeNull();

      // Attempting to refresh after explicit logout fails
      await expect(authService.refresh(rawToken)).rejects.toThrow(RefreshTokenReusedError);
    });

    it('safely handles logout with unknown or empty token', async () => {
      await expect(authService.logout(undefined)).resolves.not.toThrow();
      await expect(authService.logout('unknown-token-that-does-not-exist')).resolves.not.toThrow();
    });
  });

  describe('getCurrentUser', () => {
    it('returns safe user details for active user', async () => {
      const auth = await authService.register({
        email: 'helen@example.com',
        password: 'HelenPassword123'
      });

      const safeUser = await authService.getCurrentUser(auth.user.id);
      expect(safeUser.id).toBe(auth.user.id);
      expect(safeUser.email).toBe('helen@example.com');
      expect((safeUser as any).passwordHash).toBeUndefined();
    });

    it('throws UserNotFoundError for non-existent user', async () => {
      await expect(authService.getCurrentUser('00000000-0000-0000-0000-000000000000')).rejects.toThrow(
        UserNotFoundError
      );
    });

    it('throws AccountDisabledError for disabled user', async () => {
      const auth = await authService.register({
        email: 'disabled@example.com',
        password: 'Password123'
      });

      await authRepository.updateUserStatus(auth.user.id, 'DISABLED');

      await expect(authService.getCurrentUser(auth.user.id)).rejects.toThrow(AccountDisabledError);
    });
  });
});
