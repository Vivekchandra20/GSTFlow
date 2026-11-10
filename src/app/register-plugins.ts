import { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { ServerConfig } from '../config/server.config.js';
import { getEnvConfig } from '../config/env.js';
import requestContextPlugin from '../api/plugins/request-context.js';
import validationPlugin from '../api/plugins/validation.js';
import errorHandlerPlugin from '../api/plugins/error-handler.js';
import authenticationPlugin from '../api/plugins/authentication.js';
import { createHealthRoutes, apiV1Routes } from '../api/routes/index.js';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { IAuthRepository, PrismaAuthRepository } from '../modules/auth/auth.repository.js';
import { InMemoryAuthRepository } from '../modules/auth/in-memory-auth.repository.js';
import {
  IOrganizationRepository,
  PrismaOrganizationRepository
} from '../modules/organizations/organization.repository.js';
import { InMemoryOrganizationRepository } from '../modules/organizations/in-memory-organization.repository.js';
import {
  IGstRegistrationRepository,
  PrismaGstRegistrationRepository
} from '../modules/gst-registrations/gst-registration.repository.js';
import { InMemoryGstRegistrationRepository } from '../modules/gst-registrations/in-memory-gst-registration.repository.js';
import {
  IImportRepository,
  PrismaImportRepository
} from '../modules/imports/import.repository.js';
import { InMemoryImportRepository } from '../modules/imports/in-memory-import.repository.js';

export interface PluginRegistrationOptions {
  config: ServerConfig;
  prisma?: PrismaClient;
  redis?: Redis;
  authRepository?: IAuthRepository;
  organizationRepository?: IOrganizationRepository;
  gstRegistrationRepository?: IGstRegistrationRepository;
  importRepository?: IImportRepository;
}

/**
 * Registers all core plugins, middleware, security headers, context, and routes.
 */
export async function registerPlugins(
  fastify: FastifyInstance,
  options: PluginRegistrationOptions
): Promise<void> {
  const {
    config,
    prisma,
    redis,
    authRepository,
    organizationRepository,
    gstRegistrationRepository,
    importRepository
  } = options;

  // Decorate fastify with prisma and redis if provided
  if (prisma && !fastify.hasDecorator('prisma')) {
    fastify.decorate('prisma', prisma);
  }
  if (redis && !fastify.hasDecorator('redis')) {
    fastify.decorate('redis', redis);
  }

  // Decorate authRepository
  if (!fastify.hasDecorator('authRepository')) {
    if (authRepository) {
      fastify.decorate('authRepository', authRepository);
    } else if (prisma) {
      fastify.decorate('authRepository', new PrismaAuthRepository(prisma));
    } else {
      fastify.decorate('authRepository', new InMemoryAuthRepository());
    }
  }

  // Decorate organizationRepository
  if (!fastify.hasDecorator('organizationRepository')) {
    if (organizationRepository) {
      fastify.decorate('organizationRepository', organizationRepository);
    } else if (prisma) {
      fastify.decorate('organizationRepository', new PrismaOrganizationRepository(prisma));
    } else {
      fastify.decorate('organizationRepository', new InMemoryOrganizationRepository());
    }
  }

  // Decorate gstRegistrationRepository
  if (!fastify.hasDecorator('gstRegistrationRepository')) {
    if (gstRegistrationRepository) {
      fastify.decorate('gstRegistrationRepository', gstRegistrationRepository);
    } else if (prisma) {
      fastify.decorate('gstRegistrationRepository', new PrismaGstRegistrationRepository(prisma));
    } else {
      fastify.decorate('gstRegistrationRepository', new InMemoryGstRegistrationRepository());
    }
  }

  // Decorate importRepository
  if (!fastify.hasDecorator('importRepository')) {
    if (importRepository) {
      fastify.decorate('importRepository', importRepository);
    } else if (prisma) {
      fastify.decorate('importRepository', new PrismaImportRepository(prisma));
    } else {
      fastify.decorate('importRepository', new InMemoryImportRepository());
    }
  }

  // 1. Security Headers (Helmet)
  await fastify.register(helmet, config.helmetOptions);

  // 2. Cross-Origin Resource Sharing (CORS)
  await fastify.register(cors, config.corsOptions);

  // Gracefully handle empty application/json payloads without throwing FST_ERR_CTP_EMPTY_JSON_BODY
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body: string, done) => {
    if (!body || body.trim() === '') {
      done(null, undefined);
      return;
    }
    try {
      const json = JSON.parse(body);
      done(null, json);
    } catch (err: any) {
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  // 3. Multipart Upload Support
  await fastify.register(fastifyMultipart, {
    limits: {
      fileSize: 50 * 1024 * 1024, // 50MB maximum upload size
      files: 1, // At most 1 file per upload request
      fields: 10
    }
  });

  // 3. Request Context (Request ID, timing, propagation)
  await fastify.register(requestContextPlugin);

  // 4. Schema Validation & Serialization (Zod)
  await fastify.register(validationPlugin);

  // 5. Cookie Support
  await fastify.register(fastifyCookie, {
    secret: getEnvConfig().COOKIE_SECRET
  });

  // 6. Authentication Hook/Plugin (fastify.authenticate)
  await fastify.register(authenticationPlugin);

  // 7. Centralized Error Handling & Not Found Handlers
  await fastify.register(errorHandlerPlugin);

  // 8. Operational Health Endpoints (/health, /health/ready)
  await fastify.register(createHealthRoutes({
    prisma,
    redis,
    timeoutMs: config.healthTimeoutMs
  }));

  // 9. Versioned API Routes (/api/v1)
  await fastify.register(apiV1Routes, { prefix: '/api/v1' });
}
