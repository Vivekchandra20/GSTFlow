import jwt, { SignOptions, VerifyOptions } from 'jsonwebtoken';
import crypto from 'crypto';
import { getEnvConfig } from '../../config/env.js';
import { AccessTokenPayload } from './auth.types.js';
import { InvalidAccessTokenError, AccessTokenExpiredError } from './auth.errors.js';

export interface TokenServiceOptions {
  secret?: string;
  accessSecret?: string;
  accessTtlSeconds?: number;
  issuer?: string;
  audience?: string;
}

export class TokenService {
  private readonly secret: string;
  private readonly accessTtlSeconds: number;
  private readonly issuer: string;
  private readonly audience: string;

  constructor(options: TokenServiceOptions = {}) {
    const env = getEnvConfig();
    this.secret = options.secret ?? options.accessSecret ?? env.JWT_ACCESS_SECRET;
    this.accessTtlSeconds = options.accessTtlSeconds ?? env.JWT_ACCESS_TTL_SECONDS;
    this.issuer = options.issuer ?? env.JWT_ISSUER;
    this.audience = options.audience ?? env.JWT_AUDIENCE;
  }

  /**
   * Issues a signed, short-lived JWT access token with restricted algorithm and strict claims.
   */
  public signAccessToken(userId: string): { accessToken: string; expiresIn: number } {
    const payload = {
      sub: userId,
      type: 'access'
    };

    const options: SignOptions = {
      algorithm: 'HS256',
      expiresIn: this.accessTtlSeconds,
      issuer: this.issuer,
      audience: this.audience,
      jwtid: crypto.randomUUID()
    };

    const accessToken = jwt.sign(payload, this.secret, options);
    return {
      accessToken,
      expiresIn: this.accessTtlSeconds
    };
  }

  /**
   * Verifies an access token with explicit algorithm whitelisting, issuer, and audience validation.
   */
  public verifyAccessToken(token: string): AccessTokenPayload {
    const options: VerifyOptions = {
      algorithms: ['HS256'], // Strictly enforce HS256 to prevent algorithm confusion attacks
      issuer: this.issuer,
      audience: this.audience
    };

    try {
      const decoded = jwt.verify(token, this.secret, options) as any;

      if (!decoded || typeof decoded !== 'object' || decoded.type !== 'access' || !decoded.sub) {
        throw new InvalidAccessTokenError('Invalid token type or missing subject claim.');
      }

      return {
        sub: decoded.sub,
        type: 'access',
        iss: decoded.iss,
        aud: decoded.aud,
        iat: decoded.iat,
        exp: decoded.exp,
        jti: decoded.jti
      };
    } catch (err: any) {
      if (err instanceof jwt.TokenExpiredError) {
        throw new AccessTokenExpiredError();
      }
      if (err instanceof AuthError) {
        throw err;
      }
      throw new InvalidAccessTokenError(err.message || 'Token verification failed.');
    }
  }

  /**
   * Generates a cryptographically secure opaque refresh token and its SHA-256 hash.
   */
  public generateRefreshToken(): { rawToken: string; tokenHash: string } {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = this.hashRefreshToken(rawToken);
    return { rawToken, tokenHash };
  }

  /**
   * Computes a deterministic SHA-256 hash of an opaque refresh token for database storage/lookup.
   */
  public hashRefreshToken(rawToken: string): string {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
  }
}

// Re-export AuthError for instanceof check
import { AuthError } from './auth.errors.js';
