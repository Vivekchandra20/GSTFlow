import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import { TokenService } from '../../../src/modules/auth/token.service.js';
import {
  InvalidAccessTokenError,
  AccessTokenExpiredError
} from '../../../src/modules/auth/auth.errors.js';

describe('TokenService', () => {
  const secret = 'test-secret-at-least-32-characters-long-key!';
  const issuer = 'gstflow-auth';
  const audience = 'gstflow-api';
  const tokenService = new TokenService({
    accessSecret: secret,
    accessTtlSeconds: 2, // 2 seconds for testing
    issuer,
    audience
  });

  it('signs and verifies a valid JWT access token', () => {
    const userId = '11111111-2222-3333-4444-555555555555';
    const { accessToken, expiresIn } = tokenService.signAccessToken(userId);

    expect(accessToken).toBeDefined();
    expect(expiresIn).toBe(2);

    const payload = tokenService.verifyAccessToken(accessToken);
    expect(payload.sub).toBe(userId);
    expect(payload.iss).toBe(issuer);
    expect(payload.aud).toBe(audience);
    expect(payload.jti).toBeDefined();
  });

  it('throws AccessTokenExpiredError when token is expired', async () => {
    const expiredService = new TokenService({
      accessSecret: secret,
      accessTtlSeconds: 1,
      issuer,
      audience
    });

    const { accessToken } = expiredService.signAccessToken('user-1');

    // Wait 1.1s for token to expire
    await new Promise((r) => setTimeout(r, 1100));

    expect(() => expiredService.verifyAccessToken(accessToken)).toThrow(AccessTokenExpiredError);
  });

  it('throws InvalidAccessTokenError for tampered or invalid signatures', () => {
    const { accessToken } = tokenService.signAccessToken('user-1');
    const tampered = accessToken.slice(0, -5) + 'abcde';

    expect(() => tokenService.verifyAccessToken(tampered)).toThrow(InvalidAccessTokenError);
  });

  it('rejects tokens signed with unauthorized algorithm (e.g. none)', () => {
    // Generate an unsigned 'none' token
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: 'user-hacker', iss: issuer, aud: audience, exp: Math.floor(Date.now() / 1000) + 3600 })
    ).toString('base64url');
    const noneToken = `${header}.${payload}.`;

    expect(() => tokenService.verifyAccessToken(noneToken)).toThrow(InvalidAccessTokenError);
  });

  it('generates high-entropy refresh tokens and consistent SHA-256 hashes', () => {
    const { rawToken, tokenHash } = tokenService.generateRefreshToken();

    expect(rawToken).toBeDefined();
    expect(rawToken.length).toBeGreaterThanOrEqual(64);
    expect(tokenHash).toBeDefined();
    expect(tokenHash.length).toBe(64); // SHA-256 hex is 64 characters

    const recomputedHash = tokenService.hashRefreshToken(rawToken);
    expect(recomputedHash).toBe(tokenHash);
  });
});
