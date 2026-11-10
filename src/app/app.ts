import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { EnvConfig, getEnvConfig } from '../config/env.js';
import { buildServerConfig } from '../config/server.config.js';
import { registerPlugins } from './register-plugins.js';
import { IAuthRepository } from '../modules/auth/auth.repository.js';
import { IOrganizationRepository } from '../modules/organizations/organization.repository.js';
import { IGstRegistrationRepository } from '../modules/gst-registrations/gst-registration.repository.js';
import { IImportRepository } from '../modules/imports/import.repository.js';

export interface AppBuildOptions {
  env?: EnvConfig;
  prisma?: PrismaClient;
  redis?: Redis;
  authRepository?: IAuthRepository;
  organizationRepository?: IOrganizationRepository;
  gstRegistrationRepository?: IGstRegistrationRepository;
  importRepository?: IImportRepository;
  fastifyOverrides?: Partial<FastifyServerOptions>;
}

/**
 * Builds and configures an isolated Fastify application instance.
 *
 * Does not start network listening or background workers.
 * Suitable for both production startup and in-memory test suites (`app.inject()`).
 */
export async function buildApp(options: AppBuildOptions = {}): Promise<FastifyInstance> {
  const env = options.env || getEnvConfig();
  const serverConfig = buildServerConfig(env);

  const mergedFastifyOptions: FastifyServerOptions = {
    ...serverConfig.fastifyOptions,
    ...options.fastifyOverrides
  };

  const app: FastifyInstance = Fastify(mergedFastifyOptions);

  await registerPlugins(app, {
    config: serverConfig,
    prisma: options.prisma,
    redis: options.redis,
    authRepository: options.authRepository,
    organizationRepository: options.organizationRepository,
    gstRegistrationRepository: options.gstRegistrationRepository,
    importRepository: options.importRepository
  });

  return app;
}
