import { FastifyRequest, FastifyReply } from 'fastify';
import { AuthService } from './auth.service.js';
import { RegisterBody, LoginBody, RefreshBody, LogoutBody } from './auth.schemas.js';
import { ClientMetadata } from './auth.types.js';
import { InvalidRefreshTokenError, UnauthenticatedError } from './auth.errors.js';
import { getEnvConfig } from '../../config/env.js';

export class AuthController {
  private readonly refreshTtlSeconds: number;

  constructor(private readonly authService: AuthService) {
    const env = getEnvConfig();
    this.refreshTtlSeconds = env.REFRESH_TOKEN_TTL_SECONDS;
  }

  public register = async (
    request: FastifyRequest<{ Body: RegisterBody }>,
    reply: FastifyReply
  ): Promise<void> => {
    const clientMeta = this.extractClientMetadata(request);
    const result = await this.authService.register(request.body, clientMeta);

    this.attachRefreshTokenCookie(reply, result.tokens.refreshToken);

    reply.status(201).send({
      success: true,
      data: result
    });
  };

  public login = async (
    request: FastifyRequest<{ Body: LoginBody }>,
    reply: FastifyReply
  ): Promise<void> => {
    const clientMeta = this.extractClientMetadata(request);
    const result = await this.authService.login(request.body, clientMeta);

    this.attachRefreshTokenCookie(reply, result.tokens.refreshToken);

    reply.status(200).send({
      success: true,
      data: result
    });
  };

  public refresh = async (
    request: FastifyRequest<{ Body: RefreshBody }>,
    reply: FastifyReply
  ): Promise<void> => {
    const rawRefreshToken =
      request.body?.refreshToken || (request.cookies ? request.cookies.refreshToken : undefined);

    if (!rawRefreshToken) {
      throw new InvalidRefreshTokenError('Refresh token is required');
    }

    const clientMeta = this.extractClientMetadata(request);
    const result = await this.authService.refresh(rawRefreshToken, clientMeta);

    this.attachRefreshTokenCookie(reply, result.tokens.refreshToken);

    reply.status(200).send({
      success: true,
      data: result
    });
  };

  public logout = async (
    request: FastifyRequest<{ Body: LogoutBody }>,
    reply: FastifyReply
  ): Promise<void> => {
    const rawRefreshToken =
      request.body?.refreshToken || (request.cookies ? request.cookies.refreshToken : undefined);

    if (rawRefreshToken) {
      await this.authService.logout(rawRefreshToken);
    }

    this.clearRefreshTokenCookie(reply);

    reply.status(200).send({
      success: true,
      data: {
        message: 'Successfully logged out'
      }
    });
  };

  public me = async (
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> => {
    if (!request.user || !request.user.userId) {
      throw new UnauthenticatedError('Authentication required');
    }

    const user = await this.authService.getCurrentUser(request.user.userId);

    reply.status(200).send({
      success: true,
      data: {
        user
      }
    });
  };

  private extractClientMetadata(request: FastifyRequest): ClientMetadata {
    return {
      userAgent: request.headers['user-agent'],
      ipAddress: request.ip || (request.headers['x-forwarded-for'] as string)
    };
  }

  private attachRefreshTokenCookie(reply: FastifyReply, token: string): void {
    if (typeof (reply as any).setCookie === 'function') {
      (reply as any).setCookie('refreshToken', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/api/v1/auth',
        maxAge: this.refreshTtlSeconds
      });
    }
  }

  private clearRefreshTokenCookie(reply: FastifyReply): void {
    if (typeof (reply as any).clearCookie === 'function') {
      (reply as any).clearCookie('refreshToken', {
        path: '/api/v1/auth'
      });
    }
  }
}
