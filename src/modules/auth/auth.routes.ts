import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { AuthService } from './auth.service.js';
import { AuthController } from './auth.controller.js';
import { IAuthRepository, PrismaAuthRepository } from './auth.repository.js';
import {
  RegisterBodySchema,
  LoginBodySchema,
  RefreshBodySchema,
  LogoutBodySchema,
  AuthResponseSchema,
  MeResponseSchema,
  LogoutResponseSchema
} from './auth.schemas.js';

export interface AuthRoutesOptions {
  authService?: AuthService;
  authRepository?: IAuthRepository;
}

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (
  fastify: FastifyInstance,
  options: AuthRoutesOptions
) => {
  let authService = options.authService;
  if (!authService) {
    let authRepository = options.authRepository || fastify.authRepository;
    if (!authRepository) {
      if (fastify.prisma) {
        authRepository = new PrismaAuthRepository(fastify.prisma);
      } else {
        throw new Error('PrismaClient decorator not found on FastifyInstance. Cannot initialize AuthRepository.');
      }
    }
    authService = new AuthService(authRepository);
  }

  const controller = new AuthController(authService);

  // 1. POST /register
  fastify.post(
    '/register',
    {
      schema: {
        body: RegisterBodySchema,
        response: {
          201: AuthResponseSchema
        }
      }
    },
    controller.register
  );

  // 2. POST /login
  fastify.post(
    '/login',
    {
      schema: {
        body: LoginBodySchema,
        response: {
          200: AuthResponseSchema
        }
      }
    },
    controller.login
  );

  // 3. POST /refresh
  fastify.post(
    '/refresh',
    {
      schema: {
        body: RefreshBodySchema,
        response: {
          200: AuthResponseSchema
        }
      }
    },
    controller.refresh
  );

  // 4. POST /logout
  fastify.post(
    '/logout',
    {
      schema: {
        body: LogoutBodySchema,
        response: {
          200: LogoutResponseSchema
        }
      }
    },
    controller.logout
  );

  // 5. GET /me (Protected)
  fastify.get(
    '/me',
    {
      preHandler: [fastify.authenticate],
      schema: {
        response: {
          200: MeResponseSchema
        }
      }
    },
    controller.me
  );
};
