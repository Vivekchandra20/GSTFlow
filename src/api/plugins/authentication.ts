import { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { TokenService } from '../../modules/auth/token.service.js';
import { IAuthRepository, PrismaAuthRepository } from '../../modules/auth/auth.repository.js';
import { AuthenticatedUser } from '../../modules/auth/auth.types.js';
import {
  UnauthenticatedError,
  AccountDisabledError,
  UserNotFoundError
} from '../../modules/auth/auth.errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
  interface FastifyInstance {
    prisma?: PrismaClient;
    redis?: Redis;
    authRepository?: IAuthRepository;
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export interface AuthenticationPluginOptions {
  tokenService?: TokenService;
  authRepository?: IAuthRepository;
}

const authenticationPlugin: FastifyPluginAsync<AuthenticationPluginOptions> = async (
  fastify: FastifyInstance,
  options: AuthenticationPluginOptions
) => {
  const tokenService = options.tokenService || new TokenService();

  const getAuthRepo = (): IAuthRepository | undefined => {
    if (options.authRepository) {
      return options.authRepository;
    }
    if (fastify.authRepository) {
      return fastify.authRepository;
    }
    if (fastify.prisma) {
      return new PrismaAuthRepository(fastify.prisma);
    }
    return undefined;
  };

  const authenticate = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const authHeader = request.headers.authorization;

    if (!authHeader) {
      throw new UnauthenticatedError('Missing Authorization header');
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer' || !parts[1]) {
      throw new UnauthenticatedError('Invalid Authorization header format. Expected Bearer <token>');
    }

    const rawToken = parts[1];
    const payload = tokenService.verifyAccessToken(rawToken);

    const repo = getAuthRepo();
    if (repo) {
      const user = await repo.findUserById(payload.sub);
      if (!user) {
        throw new UserNotFoundError('User associated with token no longer exists');
      }

      if (user.status === 'DISABLED') {
        throw new AccountDisabledError('User account is disabled');
      }

      request.user = {
        userId: user.id,
        email: user.email,
        status: user.status
      };
    } else {
      request.user = {
        userId: payload.sub,
        email: '',
        status: 'ACTIVE'
      };
    }
  };

  fastify.decorate('authenticate', authenticate);
};

export default fp(authenticationPlugin, {
  name: 'authentication',
  fastify: '5.x'
});
