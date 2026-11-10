import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { IImportRepository, PrismaImportRepository } from './import.repository.js';
import { InMemoryImportRepository } from './in-memory-import.repository.js';
import {
  IGstRegistrationRepository,
  PrismaGstRegistrationRepository
} from '../gst-registrations/gst-registration.repository.js';
import { InMemoryGstRegistrationRepository } from '../gst-registrations/in-memory-gst-registration.repository.js';
import {
  IOrganizationRepository,
  PrismaOrganizationRepository
} from '../organizations/organization.repository.js';
import { InMemoryOrganizationRepository } from '../organizations/in-memory-organization.repository.js';
import {
  ISourceRecordRepository,
  IImportBatchRepository
} from '../../repositories/types.js';
import { PrismaSourceRecordRepository } from '../../repositories/prisma/prisma-source-record.repository.js';
import { PrismaImportBatchRepository } from '../../repositories/prisma/prisma-import-batch.repository.js';
import { SourceStagingService } from '../../application/persistent-pipeline/source-staging.service.js';
import { OutboxDispatcher } from '../../infrastructure/queue/outbox-dispatcher.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { createRequireOrganizationPermission } from '../authorization/authorization.hooks.js';
import { ImportService } from './import.service.js';
import { ImportController } from './import.controller.js';
import { orgParamSchema, importBatchParamSchema } from './import.schemas.js';

declare module 'fastify' {
  interface FastifyInstance {
    importRepository?: IImportRepository;
    importService?: ImportService;
    stagingService?: SourceStagingService;
    outboxDispatcher?: OutboxDispatcher;
  }
}

export interface ImportRoutesOptions {
  importRepository?: IImportRepository;
  gstRegistrationRepository?: IGstRegistrationRepository;
  organizationRepository?: IOrganizationRepository;
  sourceRecordRepository?: ISourceRecordRepository;
  batchRepository?: IImportBatchRepository;
  stagingService?: SourceStagingService;
  outboxDispatcher?: OutboxDispatcher;
}

export const importRoutes: FastifyPluginAsync<ImportRoutesOptions> = async (
  fastify: FastifyInstance,
  options: ImportRoutesOptions
) => {
  // 1. Resolve Import Repository
  let importRepo = options.importRepository || fastify.importRepository;
  if (!importRepo) {
    if (fastify.prisma) {
      importRepo = new PrismaImportRepository(fastify.prisma);
    } else {
      importRepo = new InMemoryImportRepository();
    }
  }

  // 2. Resolve GST Registration Repository
  let gstRepo = options.gstRegistrationRepository || fastify.gstRegistrationRepository;
  if (!gstRepo) {
    if (fastify.prisma) {
      gstRepo = new PrismaGstRegistrationRepository(fastify.prisma);
    } else {
      gstRepo = new InMemoryGstRegistrationRepository();
    }
  }

  // 3. Resolve Organization Repository & Authz
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

  // 4. Resolve Staging & Source Record Dependencies if available
  let batchRepo = options.batchRepository;
  let sourceRecordRepo = options.sourceRecordRepository;
  let stagingService = options.stagingService || fastify.stagingService;

  if (fastify.prisma) {
    if (!batchRepo) {
      batchRepo = new PrismaImportBatchRepository(fastify.prisma);
    }
    if (!sourceRecordRepo) {
      sourceRecordRepo = new PrismaSourceRecordRepository(fastify.prisma);
    }
    if (!stagingService && sourceRecordRepo && batchRepo) {
      stagingService = new SourceStagingService({
        sourceRecordRepo,
        batchRepo
      });
    }
  }

  const importService =
    fastify.importService ||
    new ImportService({
      importRepo,
      gstRegistrationRepo: gstRepo,
      batchRepo,
      sourceRecordRepo,
      stagingService,
      outboxDispatcher: options.outboxDispatcher || fastify.outboxDispatcher
    });

  const controller = new ImportController(importService);

  // 1. POST /api/v1/organizations/:organizationId/imports (Upload source file & create import)
  fastify.post(
    '/:organizationId/imports',
    {
      preHandler: [fastify.authenticate, requirePermission('import:create')],
      schema: {
        params: orgParamSchema
      }
    },
    controller.handleUploadAndCreateImport
  );

  // 2. GET /api/v1/organizations/:organizationId/imports (List organization imports)
  fastify.get(
    '/:organizationId/imports',
    {
      preHandler: [fastify.authenticate, requirePermission('import:read')],
      schema: {
        params: orgParamSchema
      }
    },
    controller.handleListImports
  );

  // 3. GET /api/v1/organizations/:organizationId/imports/:batchId (Get import details)
  fastify.get(
    '/:organizationId/imports/:batchId',
    {
      preHandler: [fastify.authenticate, requirePermission('import:read')],
      schema: {
        params: importBatchParamSchema
      }
    },
    controller.handleGetImport
  );

  // 4. GET /api/v1/organizations/:organizationId/imports/:batchId/status (Get processing status)
  fastify.get(
    '/:organizationId/imports/:batchId/status',
    {
      preHandler: [fastify.authenticate, requirePermission('import:read')],
      schema: {
        params: importBatchParamSchema
      }
    },
    controller.handleGetImportStatus
  );

  // 5. GET /api/v1/organizations/:organizationId/imports/:batchId/summary (Get processing summary)
  fastify.get(
    '/:organizationId/imports/:batchId/summary',
    {
      preHandler: [fastify.authenticate, requirePermission('import:read')],
      schema: {
        params: importBatchParamSchema
      }
    },
    controller.handleGetImportSummary
  );
};
