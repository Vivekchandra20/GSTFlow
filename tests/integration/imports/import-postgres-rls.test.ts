import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import pg from 'pg';
import { PrismaClient } from '@prisma/client';
import { EmbeddedPostgres } from 'embedded-postgres';
import { PrismaImportRepository } from '../../../src/modules/imports/import.repository.js';
import { PrismaGstRegistrationRepository } from '../../../src/modules/gst-registrations/gst-registration.repository.js';
import { PrismaOrganizationRepository } from '../../../src/modules/organizations/organization.repository.js';
import { PrismaAuthRepository } from '../../../src/modules/auth/auth.repository.js';
import { PrismaOutboxRepository } from '../../../src/repositories/prisma/prisma-outbox.repository.js';
import { PrismaProcessingJobRepository } from '../../../src/repositories/prisma/prisma-processing-job.repository.js';
import { OutboxDispatcher } from '../../../src/infrastructure/queue/outbox-dispatcher.js';
import { IQueueService } from '../../../src/infrastructure/queue/queue.service.js';
import { BatchProcessingJobPayload } from '../../../src/infrastructure/queue/job.types.js';
import {
  TenantContext,
  BatchStatus,
  JobStatus,
  ExecutionCheckpoint
} from '../../../src/repositories/types.js';
import { GstRegistrationNotEligibleError } from '../../../src/modules/imports/import.errors.js';
import { ImportService } from '../../../src/modules/imports/import.service.js';

describe('Phase 4.2.5: PostgreSQL 16 RLS & Outbox Integration Suite', () => {
  const testPort = 54348;
  const testDbDir = path.resolve('.pgdata_phase4_2_5_import');
  const testDbName = 'gstflow_phase4_2_5_test';

  let pgServer: EmbeddedPostgres;
  let adminClient: pg.Client;
  let prisma: PrismaClient;

  let importRepo: PrismaImportRepository;
  let gstRepo: PrismaGstRegistrationRepository;
  let orgRepo: PrismaOrganizationRepository;
  let authRepo: PrismaAuthRepository;
  let outboxRepo: PrismaOutboxRepository;
  let jobRepo: PrismaProcessingJobRepository;

  const orgAId = 'a1111111-1111-4111-8111-111111111111';
  const orgBId = 'b2222222-2222-4222-8222-222222222222';
  const ctxA: TenantContext = { organizationId: orgAId };
  const ctxB: TenantContext = { organizationId: orgBId };

  let orgAGstRegId: string;
  let orgBGstRegId: string;

  beforeAll(async () => {
    // 1. Initialise and start embedded Postgres on testPort
    const epModule = await import('embedded-postgres');
    const EmbeddedPostgresClass = (epModule as any).default || epModule;
    pgServer = new (EmbeddedPostgresClass as any)({
      databaseDir: testDbDir,
      port: testPort,
      user: 'postgres',
      password: 'postgrespassword',
      persistent: false
    });

    if (fs.existsSync(testDbDir)) {
      try {
        fs.rmSync(testDbDir, { recursive: true, force: true });
      } catch {
        // Suppress initial unlink error
      }
    }

    await pgServer.initialise();
    await pgServer.start();

    // 2. Connect as root admin to create test database
    const rootClient = new pg.Client({
      host: 'localhost',
      port: testPort,
      user: 'postgres',
      password: 'postgrespassword',
      database: 'postgres'
    });
    await rootClient.connect();
    await rootClient.query(`DROP DATABASE IF EXISTS ${testDbName};`);
    await rootClient.query(`CREATE DATABASE ${testDbName};`);
    await rootClient.end();

    // 3. Connect to test DB as admin and apply all 6 migrations sequentially
    adminClient = new pg.Client({
      host: 'localhost',
      port: testPort,
      user: 'postgres',
      password: 'postgrespassword',
      database: testDbName
    });
    await adminClient.connect();

    const migrationFiles = [
      'prisma/migrations/20261107000000_init_persistence_foundation/migration.sql',
      'prisma/migrations/20261108000000_phase4_1_asynchronous_outbox_jobs/migration.sql',
      'prisma/migrations/20261109000000_phase4_2_2_user_authentication/migration.sql',
      'prisma/migrations/20261109010000_phase4_2_3_organization_membership_rbac/migration.sql',
      'prisma/migrations/20261109020000_phase4_2_4_gst_registration_lifecycle/migration.sql',
      'prisma/migrations/20261109030000_phase4_2_5_import_platform_and_gstin/migration.sql',
      'prisma/migrations/20261109040000_phase4_2_6_invitation_discovery_functions/migration.sql'
    ];

    for (const migPath of migrationFiles) {
      const sql = fs.readFileSync(path.resolve(migPath), 'utf8');
      await adminClient.query(sql);
    }

    // 4. Connect Prisma as application user (gstflow_app with RLS active)
    const databaseUrl = `postgresql://gstflow_app:gstflow_app_password@localhost:${testPort}/${testDbName}`;
    prisma = new PrismaClient({
      datasources: {
        db: { url: databaseUrl }
      }
    });
    await prisma.$connect();

    importRepo = new PrismaImportRepository(prisma);
    gstRepo = new PrismaGstRegistrationRepository(prisma);
    orgRepo = new PrismaOrganizationRepository(prisma);
    authRepo = new PrismaAuthRepository(prisma);
    outboxRepo = new PrismaOutboxRepository(prisma);
    jobRepo = new PrismaProcessingJobRepository(prisma);

    // 5. Seed test organizations and users
    const userA = await authRepo.createUser({ email: 'owner_a@example.com', normalizedEmail: 'owner_a@example.com', passwordHash: 'hash' });
    const userB = await authRepo.createUser({ email: 'owner_b@example.com', normalizedEmail: 'owner_b@example.com', passwordHash: 'hash' });

    await orgRepo.createOrganizationWithOwner({
      id: orgAId,
      name: 'Corporation Alpha Pvt Ltd',
      slug: 'corp-alpha',
      pan: 'AAPFU0939F',
      userId: userA.id
    });

    await orgRepo.createOrganizationWithOwner({
      id: orgBId,
      name: 'Beta Enterprises Ltd',
      slug: 'beta-ent',
      pan: 'AABCU9603R',
      userId: userB.id
    });

    // 6. Seed GST Registrations via GstRegistrationService (wrapped in tenant transaction)
    const { GstRegistrationService } = await import('../../../src/modules/gst-registrations/gst-registration.service.js');
    const gstService = new GstRegistrationService(gstRepo);

    const regA = await gstService.createRegistration(orgAId, {
      gstin: '27AAPFU0939F1ZV',
      legalName: 'Alpha Maharashtra'
    });
    orgAGstRegId = regA.id;

    const regB = await gstService.createRegistration(orgBId, {
      gstin: '29AABCU9603R1ZJ',
      legalName: 'Beta Karnataka'
    });
    orgBGstRegId = regB.id;
  }, 90000);

  afterAll(async () => {
    try {
      if (prisma) await prisma.$disconnect();
    } catch {
      // Ignore disconnect error
    }
    try {
      if (adminClient) await adminClient.end();
    } catch {
      // Ignore admin client error
    }
    try {
      if (pgServer) await pgServer.stop();
    } catch {
      // Ignore stop error
    }
    try {
      if (fs.existsSync(testDbDir)) {
        fs.rmSync(testDbDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore final unlink on Windows file lock
    }
  });

  describe('PostgreSQL RLS & Foreign Key Enforcement', () => {
    it('creates an ImportBatch under Org A with gstRegistrationId and sourcePlatform', async () => {
      const batch = await importRepo.createImportBatch(ctxA, {
        batchNumber: 'BATCH-RLS-001',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1',
        gstRegistrationId: orgAGstRegId,
        sourcePlatform: 'AMAZON'
      });

      expect(batch.id).toBeDefined();
      expect(batch.organizationId).toBe(orgAId);
      expect(batch.gstRegistrationId).toBe(orgAGstRegId);
      expect(batch.sourcePlatform).toBe('AMAZON');
      expect(batch.status).toBe(BatchStatus.PENDING);

      // Verify retrieval under Org A
      const retrieved = await importRepo.getImportById(ctxA, batch.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(batch.id);
    });

    it('enforces PostgreSQL Row-Level Security: Org B cannot view Org A batches', async () => {
      const batchA = await importRepo.createImportBatch(ctxA, {
        batchNumber: 'BATCH-RLS-ORG-A',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1',
        gstRegistrationId: orgAGstRegId,
        sourcePlatform: 'AMAZON'
      });

      // Query from Org B context
      const fromOrgB = await importRepo.getImportById(ctxB, batchA.id);
      expect(fromOrgB).toBeNull();

      // List from Org B context
      const listOrgB = await importRepo.listImports(ctxB, {});
      const hasBatchA = listOrgB.items.some((b) => b.id === batchA.id);
      expect(hasBatchA).toBe(false);
    });

    it('rejects cross-tenant references: Org A cannot link batch to Org B GSTIN', async () => {
      // 1. PostgreSQL RLS isolation: Org A cannot read Org B's GST registration
      const crossGstLookup = await gstRepo.findById(orgAId, orgBGstRegId);
      expect(crossGstLookup).toBeNull();

      // 2. ImportService validation rejects cross-tenant GSTIN reference
      const importService = new ImportService({
        importRepo,
        gstRegistrationRepo: gstRepo
      });

      await expect(
        importService.createImport(orgAId, {
          filePath: '/storage/dummy.csv',
          filename: 'dummy.csv',
          fileSize: 100n,
          fileHash: 'sha256dummy',
          gstRegistrationId: orgBGstRegId, // Belongs to Org B!
          sourcePlatform: 'AMAZON'
        })
      ).rejects.toThrow(GstRegistrationNotEligibleError);
    });
  });

  describe('Transactional Outbox & Dispatcher Cycle', () => {
    it('creates ProcessingJob and OutboxEvent transactionally, and dispatcher publishes event', async () => {
      const processingJobId = crypto.randomUUID();
      const batch = await importRepo.createImportBatch(ctxA, {
        batchNumber: 'BATCH-OUTBOX-001',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1',
        gstRegistrationId: orgAGstRegId,
        sourcePlatform: 'AMAZON'
      });

      // 1. Transactionally create ProcessingJob & OutboxEvent
      const { job, outbox } = await importRepo.createJobAndOutbox(ctxA, {
        processingJobId,
        batchId: batch.id,
        filePaths: ['/storage/amazon_mtr.csv']
      });

      expect(job.id).toBe(processingJobId);
      expect(job.status).toBe(JobStatus.QUEUED);
      expect(outbox.eventType).toBe('BATCH_PROCESSING');
      expect(outbox.status).toBe('PENDING');

      // 2. Setup mock QueueService
      const enqueuedJobs: Array<{ eventId: string; payload: BatchProcessingJobPayload }> = [];
      const mockQueueService: IQueueService = {
        async enqueueBatchProcessing(eventId: string, payload: BatchProcessingJobPayload) {
          enqueuedJobs.push({ eventId, payload });
          return 'bullmq-job-123';
        },
        async close() {}
      } as any;

      // 3. Dispatch outbox events
      const dispatcher = new OutboxDispatcher({
        outboxRepo,
        queueService: mockQueueService,
        batchSize: 10,
        leaseSeconds: 30
      });

      const dispatchResult = await dispatcher.dispatchOnce();
      expect(dispatchResult.published).toBeGreaterThanOrEqual(1);
      expect(enqueuedJobs.some((j) => j.payload.processingJobId === processingJobId)).toBe(true);

      // 4. Verify outbox event status is now PUBLISHED in database
      const outboxRecord = await outboxRepo.findById(ctxA, outbox.id);
      expect(outboxRecord?.status).toBe('PUBLISHED');
      expect(outboxRecord?.publishedAt).not.toBeNull();
    });
  });
});
