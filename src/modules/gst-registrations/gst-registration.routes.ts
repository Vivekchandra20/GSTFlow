import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import {
  IGstRegistrationRepository,
  PrismaGstRegistrationRepository
} from './gst-registration.repository.js';
import { InMemoryGstRegistrationRepository } from './in-memory-gst-registration.repository.js';
import { GstRegistrationService } from './gst-registration.service.js';
import { GstRegistrationController } from './gst-registration.controller.js';
import {
  IOrganizationRepository,
  PrismaOrganizationRepository
} from '../organizations/organization.repository.js';
import { InMemoryOrganizationRepository } from '../organizations/in-memory-organization.repository.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { createRequireOrganizationPermission } from '../authorization/authorization.hooks.js';
import {
  CreateGstRegistrationBodySchema,
  UpdateGstRegistrationBodySchema,
  UpdateGstRegistrationStatusBodySchema,
  ListGstRegistrationsQuerySchema,
  GstRegistrationParamsSchema
} from './gst-registration.schemas.js';

declare module 'fastify' {
  interface FastifyInstance {
    gstRegistrationRepository?: IGstRegistrationRepository;
  }
}

export interface GstRegistrationRoutesOptions {
  gstRegistrationRepository?: IGstRegistrationRepository;
  organizationRepository?: IOrganizationRepository;
}

export const gstRegistrationRoutes: FastifyPluginAsync<GstRegistrationRoutesOptions> = async (
  fastify: FastifyInstance,
  options: GstRegistrationRoutesOptions
) => {
  // 1. Resolve repositories
  let gstRepo = options.gstRegistrationRepository || fastify.gstRegistrationRepository;
  if (!gstRepo) {
    if (fastify.prisma) {
      gstRepo = new PrismaGstRegistrationRepository(fastify.prisma);
    } else {
      gstRepo = new InMemoryGstRegistrationRepository();
    }
  }

  let orgRepo = options.organizationRepository || fastify.organizationRepository;
  if (!orgRepo) {
    if (fastify.prisma) {
      orgRepo = new PrismaOrganizationRepository(fastify.prisma);
    } else {
      orgRepo = new InMemoryOrganizationRepository();
    }
  }

  const authzService = new AuthorizationService(orgRepo);
  const requirePermission = createRequireOrganizationPermission(authzService);

  const gstService = new GstRegistrationService(gstRepo);
  const controller = new GstRegistrationController(gstService);

  // 1. POST /api/v1/organizations/:organizationId/gst-registrations (Add GST registration)
  fastify.post(
    '/:organizationId/gst-registrations',
    {
      preHandler: [fastify.authenticate, requirePermission('gstin:create')],
      schema: {
        params: GstRegistrationParamsSchema,
        body: CreateGstRegistrationBodySchema
      }
    },
    controller.createRegistration
  );

  // 2. GET /api/v1/organizations/:organizationId/gst-registrations (List registrations)
  fastify.get(
    '/:organizationId/gst-registrations',
    {
      preHandler: [fastify.authenticate, requirePermission('gstin:read')],
      schema: {
        params: GstRegistrationParamsSchema,
        querystring: ListGstRegistrationsQuerySchema
      }
    },
    controller.listRegistrations
  );

  // 3. GET /api/v1/organizations/:organizationId/gst-registrations/:gstRegistrationId (Retrieve registration)
  fastify.get(
    '/:organizationId/gst-registrations/:gstRegistrationId',
    {
      preHandler: [fastify.authenticate, requirePermission('gstin:read')],
      schema: {
        params: GstRegistrationParamsSchema
      }
    },
    controller.getRegistration
  );

  // 4. PATCH /api/v1/organizations/:organizationId/gst-registrations/:gstRegistrationId (Update registration)
  fastify.patch(
    '/:organizationId/gst-registrations/:gstRegistrationId',
    {
      preHandler: [fastify.authenticate, requirePermission('gstin:update')],
      schema: {
        params: GstRegistrationParamsSchema,
        body: UpdateGstRegistrationBodySchema
      }
    },
    controller.updateRegistration
  );

  // 5. PATCH /api/v1/organizations/:organizationId/gst-registrations/:gstRegistrationId/status (Activate/deactivate)
  fastify.patch(
    '/:organizationId/gst-registrations/:gstRegistrationId/status',
    {
      preHandler: [fastify.authenticate, requirePermission('gstin:deactivate')],
      schema: {
        params: GstRegistrationParamsSchema,
        body: UpdateGstRegistrationStatusBodySchema
      }
    },
    controller.updateRegistrationStatus
  );
};
