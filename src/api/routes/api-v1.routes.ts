import { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { authRoutes } from '../../modules/auth/auth.routes.js';
import { organizationRoutes, invitationRoutes } from '../../modules/organizations/organization.routes.js';
import { gstRegistrationRoutes } from '../../modules/gst-registrations/gst-registration.routes.js';
import { importRoutes } from '../../modules/imports/import.routes.js';

export const apiV1Routes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // Base discovery endpoint for API v1
  fastify.get('/', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.status(200).send({
      success: true,
      version: 'v1',
      description: 'GSTFlow Multi-Tenant Reconciliation REST API v1',
      timestamp: new Date().toISOString()
    });
  });

  // Auth routes: /api/v1/auth/*
  await fastify.register(authRoutes, { prefix: '/auth' });

  // Organization routes: /api/v1/organizations/*
  await fastify.register(organizationRoutes, { prefix: '/organizations' });

  // GST Registration routes: /api/v1/organizations/:organizationId/gst-registrations/*
  await fastify.register(gstRegistrationRoutes, { prefix: '/organizations' });

  // Import & Upload routes: /api/v1/organizations/:organizationId/imports/*
  await fastify.register(importRoutes, { prefix: '/organizations' });

  // Invitation routes: /api/v1/invitations/*
  await fastify.register(invitationRoutes, { prefix: '/invitations' });
};
