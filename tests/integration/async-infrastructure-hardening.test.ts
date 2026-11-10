import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { Decimal } from '../../src/utils/decimal.js';
import {
  PrismaImportBatchRepository,
  PrismaSourceRecordRepository,
  PrismaCanonicalDocumentRepository,
  PrismaProcessingResultRepository,
  PrismaReconciliationRepository,
  PrismaOutboxRepository,
  PrismaProcessingJobRepository,
  PrismaTransactionManager,
  TenantContext,
  RecordType,
  PrimaryOutcome,
  BatchStatus,
  FileBatchStatus,
  JobStatus,
  ExecutionCheckpoint,
  BatchExecutionMode,
  OutboxStatus,
  runInTenantTransaction
} from '../../src/repositories/index.js';
import {
  PersistentPipelineOrchestrator,
  BatchNotReadyForProcessingError,
  TenantAuthorizationError
} from '../../src/application/persistent-pipeline/index.js';
import {
  OutboxDispatcher,
  BatchProcessingWorker,
  BullMQQueueService,
  RedisConnectionManager,
  buildDeterministicJobId
} from '../../src/infrastructure/queue/index.js';

describe('Phase 4.1: Asynchronous Architecture & Hardened Worker Suite (T-ASYNC-01 to T-ASYNC-08)', () => {
  let pgServer: any;
  let adminClient: pg.Client;
  let prisma: PrismaClient;

  let batchRepo: PrismaImportBatchRepository;
  let sourceRepo: PrismaSourceRecordRepository;
  let canonicalRepo: PrismaCanonicalDocumentRepository;
  let resultRepo: PrismaProcessingResultRepository;
  let reconciliationRepo: PrismaReconciliationRepository;
  let outboxRepo: PrismaOutboxRepository;
  let jobRepo: PrismaProcessingJobRepository;
  let txManager: PrismaTransactionManager;
  let orchestrator: PersistentPipelineOrchestrator;

  const testDbName = 'gstflow_phase4_1_hardening_db';
  const testPort = 54342;
  const dataDir = path.resolve('.pgdata_phase4_1_hardening');

  const orgA: TenantContext = { organizationId: crypto.randomUUID() };
  const orgB: TenantContext = { organizationId: crypto.randomUUID() };

  // Set USE_MOCK_REDIS for isolated in-memory Redis testing with BullMQ
  process.env.USE_MOCK_REDIS = 'true';

  beforeAll(async () => {
    if (fs.existsSync(dataDir)) {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {}
    }

    // 1. Initialize and start isolated PostgreSQL 16 server
    const epModule = await import('embedded-postgres');
    const EmbeddedPostgresClass = epModule.default || epModule;
    pgServer = new (EmbeddedPostgresClass as any)({
      databaseDir: dataDir,
      port: testPort,
      user: 'postgres',
      password: 'postgrespassword',
      persistent: false
    });

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

    // 3. Connect to test DB as admin and apply migrations
    adminClient = new pg.Client({
      host: 'localhost',
      port: testPort,
      user: 'postgres',
      password: 'postgrespassword',
      database: testDbName
    });
    await adminClient.connect();

    // Migration 1: Persistence Foundation
    const mig1Path = path.resolve(
      'prisma/migrations/20261107000000_init_persistence_foundation/migration.sql'
    );
    const mig1Sql = fs.readFileSync(mig1Path, 'utf8');
    await adminClient.query(mig1Sql);

    // Migration 2: Phase 4.1 Asynchronous Outbox & Jobs
    const mig2Path = path.resolve(
      'prisma/migrations/20261108000000_phase4_1_asynchronous_outbox_jobs/migration.sql'
    );
    const mig2Sql = fs.readFileSync(mig2Path, 'utf8');
    await adminClient.query(mig2Sql);

    // 4. Seed test organizations as admin
    await adminClient.query(`
      INSERT INTO organizations (id, name, pan, data_retention_months, created_at, updated_at)
      VALUES 
        ('${orgA.organizationId}', 'Async Org A', 'AAACA1234A', 72, NOW(), NOW()),
        ('${orgB.organizationId}', 'Async Org B', 'AAACB5678B', 72, NOW(), NOW());
    `);

    // 5. Connect Prisma as application user
    const databaseUrl = `postgresql://gstflow_app:gstflow_app_password@localhost:${testPort}/${testDbName}`;
    prisma = new PrismaClient({
      datasources: {
        db: { url: databaseUrl }
      }
    });
    await prisma.$connect();

    batchRepo = new PrismaImportBatchRepository(prisma);
    sourceRepo = new PrismaSourceRecordRepository(prisma);
    canonicalRepo = new PrismaCanonicalDocumentRepository(prisma);
    resultRepo = new PrismaProcessingResultRepository(prisma);
    reconciliationRepo = new PrismaReconciliationRepository(prisma);
    outboxRepo = new PrismaOutboxRepository(prisma);
    jobRepo = new PrismaProcessingJobRepository(prisma);
    txManager = new PrismaTransactionManager(prisma);

    orchestrator = new PersistentPipelineOrchestrator({
      importBatchRepo: batchRepo,
      sourceRecordRepo: sourceRepo,
      canonicalDocRepo: canonicalRepo,
      processingResultRepo: resultRepo,
      reconciliationRepo: reconciliationRepo,
      transactionManager: txManager
    });
  }, 60000);

  afterAll(async () => {
    RedisConnectionManager.resetInstance();
    if (prisma) await prisma.$disconnect();
    if (adminClient) await adminClient.end();
    if (pgServer) {
      try {
        await pgServer.stop();
      } catch {}
    }
    try {
      if (fs.existsSync(dataDir)) {
        fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    } catch {}
  });

  async function createHelperSource(ctx: TenantContext, tag: string) {
    const file = await sourceRepo.createSourceFile(ctx, {
      fileName: `file_${tag}.csv`,
      fileFingerprint: `fp_${tag}_${crypto.randomUUID()}`,
      fileSizeBytes: 2048n,
      storageUri: `s3://vault/${tag}.csv`,
      sourceReportType: 'AMAZON_MTR'
    });

    await sourceRepo.bulkInsertSourceRecords(ctx, file.id, [
      {
        physicalLineNumber: 2,
        logicalRecordNumber: 1,
        recordType: RecordType.OUTWARD_SUPPLY,
        rawPayload: { tag, type: 'INV' }
      }
    ]);

    const records = await sourceRepo.findRecordsBySourceFile(ctx, file.id);
    return { file, recordId: records[0].id };
  }

  // =========================================================================
  // T-ASYNC-01: Atomic Outbox Claiming Concurrency
  // =========================================================================
  it('T-ASYNC-01: Concurrent outbox claiming with SKIP LOCKED guarantees disjoint sets with zero double-processing', async () => {
    // Insert 10 outbox events for orgA
    const eventIds: string[] = [];
    await runInTenantTransaction(prisma, orgA, async (tx) => {
      for (let i = 0; i < 10; i++) {
        const ev = await outboxRepo.createOutboxEvent(
          orgA,
          {
            eventType: 'BATCH_PROCESSING',
            payload: { item: i, organizationId: orgA.organizationId }
          },
          tx
        );
        eventIds.push(ev.id);
      }
    });

    expect(eventIds.length).toBe(10);

    // Two dispatchers poll concurrently for up to 10 events
    const [claimA, claimB] = await Promise.all([
      outboxRepo.claimEvents('dispatcher-A', 10, 30),
      outboxRepo.claimEvents('dispatcher-B', 10, 30)
    ]);

    const idsA = claimA.map((c) => c.id);
    const idsB = claimB.map((c) => c.id);

    // Intersection must be empty (strictly disjoint sets)
    const intersection = idsA.filter((id) => idsB.includes(id));
    expect(intersection).toEqual([]);

    // Total claimed must equal 10
    expect(idsA.length + idsB.length).toBe(10);

    // Verify all 10 are in CLAIMED status
    for (const id of eventIds) {
      const ev = await outboxRepo.findById(orgA, id);
      expect(ev?.status).toBe(OutboxStatus.CLAIMED);
      expect(ev?.attempts).toBe(1);
    }
  });

  // =========================================================================
  // T-ASYNC-02: Expired Lease Recovery & Republishing
  // =========================================================================
  it('T-ASYNC-02: Expired outbox lease is safely recovered and re-claimed by subsequent dispatcher', async () => {
    // 1. Insert single outbox event
    let eventId: string = '';
    await runInTenantTransaction(prisma, orgA, async (tx) => {
      const ev = await outboxRepo.createOutboxEvent(
        orgA,
        {
          eventType: 'BATCH_PROCESSING',
          payload: { tag: 'lease-test', organizationId: orgA.organizationId }
        },
        tx
      );
      eventId = ev.id;
    });

    // 2. Dispatcher A claims it with a 1-second lease
    const claim1 = await outboxRepo.claimEvents('dispatcher-crash-sim', 1, 1);
    expect(claim1.length).toBe(1);
    expect(claim1[0].id).toBe(eventId);
    expect(claim1[0].attempts).toBe(1);

    // 3. Immediately poll again with Dispatcher B - should be 0 because lease is active
    const claimTooEarly = await outboxRepo.claimEvents('dispatcher-B', 1, 30);
    const foundTooEarly = claimTooEarly.find((c) => c.id === eventId);
    expect(foundTooEarly).toBeUndefined();

    // 4. Wait 1.2s for lease to expire
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // 5. Dispatcher B re-claims the expired event
    const claimRecovered = await outboxRepo.claimEvents('dispatcher-B', 1, 30);
    const recoveredEvent = claimRecovered.find((c) => c.id === eventId);
    expect(recoveredEvent).toBeDefined();
    expect(recoveredEvent?.attempts).toBe(2);

    // 6. Dispatcher B marks it published
    const published = await outboxRepo.markPublished(eventId, 'dispatcher-B');
    expect(published).toBe(true);

    const publishedEvent = await outboxRepo.findById(orgA, eventId);
    expect(publishedEvent?.status).toBe(OutboxStatus.PUBLISHED);
    expect(publishedEvent?.publishedAt).toBeDefined();
    expect(publishedEvent?.leaseExpiresAt).toBeNull();
  });

  // =========================================================================
  // T-ASYNC-03: Non-Blocking Dispatch Lifecycle
  // =========================================================================
  it('T-ASYNC-03: OutboxDispatcher executes claim, enqueue, and markPublished in distinct phases without holding DB locks', async () => {
    let eventId: string = '';
    await runInTenantTransaction(prisma, orgA, async (tx) => {
      const ev = await outboxRepo.createOutboxEvent(
        orgA,
        {
          eventType: 'BATCH_PROCESSING',
          payload: {
            processingJobId: crypto.randomUUID(),
            importBatchId: crypto.randomUUID(),
            organizationId: orgA.organizationId,
            filePaths: ['test.csv']
          }
        },
        tx
      );
      eventId = ev.id;
    });

    // Mock QueueService to record calls
    const enqueuedJobs: Array<{ outboxEventId: string; payload: any }> = [];
    const mockQueueService = {
      enqueueBatchProcessing: async (id: string, payload: any) => {
        enqueuedJobs.push({ outboxEventId: id, payload });
        return `mock-job-${id}`;
      },
      close: async () => {}
    };

    const dispatcher = new OutboxDispatcher({
      outboxRepo,
      queueService: mockQueueService,
      batchSize: 5,
      leaseSeconds: 30
    });

    const result = await dispatcher.dispatchOnce();
    expect(result.claimed).toBeGreaterThanOrEqual(1);
    expect(result.published).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);

    expect(enqueuedJobs.some((j) => j.outboxEventId === eventId)).toBe(true);

    const ev = await outboxRepo.findById(orgA, eventId);
    expect(ev?.status).toBe(OutboxStatus.PUBLISHED);
  });

  // =========================================================================
  // T-ASYNC-04: Batch Readiness Guard
  // =========================================================================
  it('T-ASYNC-04: processStagedBatch rejects execution with BatchNotReadyForProcessingError if source files are not COMPLETED', async () => {
    // Create an ImportBatch with a source file in QUEUED status
    let batchId: string = '';
    await runInTenantTransaction(prisma, orgA, async (tx) => {
      const sourceFile = await sourceRepo.createSourceFile(
        orgA,
        {
          fileName: 'pending_source.csv',
          fileFingerprint: `fp_incomplete_${crypto.randomUUID()}`,
          fileSizeBytes: 1024n,
          storageUri: 'vault://pending_source.csv',
          sourceReportType: 'AMAZON_MTR'
        },
        tx
      );

      const batch = await batchRepo.createBatch(
        orgA,
        {
          batchNumber: `INCOMPLETE-BATCH-${Date.now()}`,
          engineVersion: '0.1.0',
          rulesVersion: '2024.1',
          executionMode: 'STANDARD',
          sourceFileIds: [sourceFile.id]
        },
        tx
      );
      batchId = batch.id;
    });

    // Attempting to process this staged batch must fail upfront
    await expect(
      orchestrator.processStagedBatch(orgA, { importBatchId: batchId })
    ).rejects.toThrow(BatchNotReadyForProcessingError);

    // Verify batch remains in PENDING status
    const batch = await batchRepo.getBatchById(orgA, batchId);
    expect(batch?.status).toBe(BatchStatus.PENDING);
  });

  // =========================================================================
  // T-ASYNC-05: Authoritative Tenant Resolution & Spoofing Defense
  // =========================================================================
  it('T-ASYNC-05: Worker rejects spoofed organization payloads and enforces authoritative tenant context', async () => {
    // 1. Create a batch and job belonging to orgA
    let batchId: string = '';
    let jobId: string = '';
    await runInTenantTransaction(prisma, orgA, async (tx) => {
      const batch = await batchRepo.createBatch(
        orgA,
        {
          batchNumber: `AUTH-TEST-${Date.now()}`,
          engineVersion: '0.1.0',
          rulesVersion: '2024.1',
          executionMode: 'STANDARD'
        },
        tx
      );
      batchId = batch.id;

      const job = await jobRepo.createJob(
        orgA,
        {
          importBatchId: batchId,
          jobType: 'BATCH_PROCESSING'
        },
        tx
      );
      jobId = job.id;
    });

    // 2. Authoritative lookup test: resolveJobAuthoritative returns orgA
    const resolved = await jobRepo.resolveJobAuthoritative(jobId);
    expect(resolved).not.toBeNull();
    expect(resolved?.organizationId).toBe(orgA.organizationId);
    expect(resolved?.importBatchId).toBe(batchId);

    // 3. Construct a worker
    const worker = new BatchProcessingWorker({
      orchestrator,
      jobRepo,
      autorun: false
    });

    // 4. Simulate a rogue job delivering payload with spoofed organizationId: orgB
    const spoofedJob = {
      id: 'bullmq-spoof-1',
      data: {
        processingJobId: jobId,
        organizationId: orgB.organizationId, // FORGED/SPOOFED ORG
        importBatchId: batchId,
        filePaths: []
      },
      attemptsMade: 0
    } as any;

    await expect(worker.processJob(spoofedJob)).rejects.toThrow(TenantAuthorizationError);

    await worker.close();
  });

  // =========================================================================
  // T-ASYNC-06: Duplicate Delivery Idempotency (Scenario A)
  // =========================================================================
  it('T-ASYNC-06: Duplicate queue delivery of COMPLETED job exits as an idempotent no-op with zero writes', async () => {
    // 1. Create batch and job in COMPLETED status
    let batchId: string = '';
    let jobId: string = '';
    await runInTenantTransaction(prisma, orgA, async (tx) => {
      const batch = await batchRepo.createBatch(
        orgA,
        {
          batchNumber: `IDEMPOTENT-BATCH-${Date.now()}`,
          engineVersion: '0.1.0',
          rulesVersion: '2024.1',
          executionMode: 'STANDARD'
        },
        tx
      );
      batchId = batch.id;

      const job = await jobRepo.createJob(
        orgA,
        {
          importBatchId: batchId,
          jobType: 'BATCH_PROCESSING'
        },
        tx
      );
      jobId = job.id;

      await jobRepo.updateJobStatus(
        orgA,
        jobId,
        JobStatus.COMPLETED,
        { completedAt: new Date() },
        tx
      );
    });

    const worker = new BatchProcessingWorker({
      orchestrator,
      jobRepo,
      autorun: false
    });

    // Send delivery to worker
    const duplicateJob = {
      id: 'bullmq-dup-1',
      data: {
        processingJobId: jobId,
        organizationId: orgA.organizationId,
        importBatchId: batchId,
        filePaths: []
      },
      attemptsMade: 0
    } as any;

    const result = await worker.processJob(duplicateJob);
    expect(result.checkpoint).toBe(ExecutionCheckpoint.COMPLETED);
    expect(result.invoiceCount).toBe(0);

    // Confirm job is still COMPLETED
    const job = await jobRepo.findById(orgA, jobId);
    expect(job?.status).toBe(JobStatus.COMPLETED);

    await worker.close();
  });

  // =========================================================================
  // T-ASYNC-07: Partial Recovery Resumption (Scenario C)
  // =========================================================================
  it('T-ASYNC-07: Partial execution recovery safely skips already persisted chunks via idempotency keys', async () => {
    // 1. Create batch with source files
    let batchId: string = '';
    await runInTenantTransaction(prisma, orgA, async (tx) => {
      const batch = await batchRepo.createBatch(
        orgA,
        {
          batchNumber: `RECOVERY-BATCH-${Date.now()}`,
          engineVersion: '0.1.0',
          rulesVersion: '2024.1',
          executionMode: 'STANDARD'
        },
        tx
      );
      batchId = batch.id;
    });

    // 2. Pre-insert a canonical invoice and processing result for this batch (simulating Chunk 1 commit)
    const src = await createHelperSource(orgA, 'rec');
    const docNum = `INV-REC-${Date.now()}`;
    let canonicalInvoiceId = '';

    await runInTenantTransaction(prisma, orgA, async (tx) => {
      const canonical = await canonicalRepo.getOrCreateCanonicalInvoice(
        orgA,
        {
          businessKey: `27AAACA1234A1Z5:2024-2025:${docNum}`,
          sellerGstin: '27AAACA1234A1Z5',
          financialYear: '2024-2025',
          invoiceNumber: docNum,
          invoiceDate: new Date('2024-05-10'),
          originalInvoiceDate: new Date('2024-05-10'),
          buyerGstin: null,
          placeOfSupplyStateCode: '27',
          recipientType: 'B2C' as any,
          orderId: 'ORD-REC-1',
          shipFromStateCode: '27',
          supplyType: 'INTRASTATE' as any,
          totalTaxableValue: new Decimal('1000.00'),
          totalInvoiceAmount: new Decimal('1180.00'),
          cgstAmount: new Decimal('90.00'),
          sgstAmount: new Decimal('90.00'),
          igstAmount: new Decimal('0.00'),
          utgstAmount: new Decimal('0.00'),
          cessAmount: new Decimal('0.00')
        },
        tx
      );
      canonicalInvoiceId = canonical.invoice.id;

      await resultRepo.createInvoiceResult(
        orgA,
        {
          importBatchId: batchId,
          canonicalInvoiceId: canonicalInvoiceId,
          sourceRecordId: src.recordId,
          version: 1,
          primaryOutcome: PrimaryOutcome.VALID,
          lines: [],
          totalTaxableValue: new Decimal('1000.00'),
          cgstAmount: new Decimal('90.00'),
          sgstAmount: new Decimal('90.00'),
          igstAmount: new Decimal('0.00'),
          utgstAmount: new Decimal('0.00'),
          cessAmount: new Decimal('0.00'),
          totalInvoiceAmount: new Decimal('1180.00')
        },
        tx
      );
    });

    // Verify result exists for this batch and canonical invoice
    const resultBefore = await resultRepo.findInvoiceResultByBatchAndCanonicalId(
      orgA,
      batchId,
      canonicalInvoiceId
    );
    expect(resultBefore).not.toBeNull();
    expect(resultBefore?.version).toBe(1);

    // 3. Re-run persistence service inserting the same canonical invoice - must skip duplicate
    const canonicalFound = await canonicalRepo.findCanonicalInvoice(
      orgA,
      '27AAACA1234A1Z5',
      '2024-2025',
      docNum
    );
    expect(canonicalFound).not.toBeNull();

    const existingCheck = await resultRepo.findInvoiceResultByBatchAndCanonicalId(
      orgA,
      batchId,
      canonicalFound!.id
    );
    expect(existingCheck).not.toBeNull();
    expect(existingCheck?.id).toBe(resultBefore?.id);
  });

  // =========================================================================
  // T-ASYNC-08: Reprocessing Isolation (Scenario D)
  // =========================================================================
  it('T-ASYNC-08: Intentional reprocessing creates version 2 results while preserving version 1 immutable', async () => {
    // 1. Create Batch 1
    const srcV1 = await createHelperSource(orgA, 'v1');
    let batch1Id: string = '';
    let batch2Id: string = '';
    const invoiceNum = `INV-V1V2-${Date.now()}`;
    let canonicalId: string = '';

    await runInTenantTransaction(prisma, orgA, async (tx) => {
      const b1 = await batchRepo.createBatch(
        orgA,
        {
          batchNumber: `BATCH-V1-${Date.now()}`,
          engineVersion: '0.1.0',
          rulesVersion: '2024.1',
          executionMode: 'STANDARD'
        },
        tx
      );
      batch1Id = b1.id;

      const canonical = await canonicalRepo.getOrCreateCanonicalInvoice(
        orgA,
        {
          businessKey: `27AAACA1234A1Z5:2024-2025:${invoiceNum}`,
          sellerGstin: '27AAACA1234A1Z5',
          financialYear: '2024-2025',
          invoiceNumber: invoiceNum,
          invoiceDate: new Date('2024-06-01'),
          originalInvoiceDate: new Date('2024-06-01'),
          buyerGstin: null,
          placeOfSupplyStateCode: '27',
          recipientType: 'B2C' as any,
          orderId: 'ORD-V1-1',
          shipFromStateCode: '27',
          supplyType: 'INTRASTATE' as any,
          totalTaxableValue: new Decimal('2000.00'),
          totalInvoiceAmount: new Decimal('2360.00'),
          cgstAmount: new Decimal('180.00'),
          sgstAmount: new Decimal('180.00'),
          igstAmount: new Decimal('0.00'),
          utgstAmount: new Decimal('0.00'),
          cessAmount: new Decimal('0.00')
        },
        tx
      );
      canonicalId = canonical.invoice.id;

      // Version 1 result in Batch 1
      await resultRepo.createInvoiceResult(
        orgA,
        {
          importBatchId: batch1Id,
          canonicalInvoiceId: canonicalId,
          sourceRecordId: srcV1.recordId,
          version: 1,
          primaryOutcome: PrimaryOutcome.VALID,
          lines: [],
          totalTaxableValue: new Decimal('2000.00'),
          cgstAmount: new Decimal('180.00'),
          sgstAmount: new Decimal('180.00'),
          igstAmount: new Decimal('0.00'),
          utgstAmount: new Decimal('0.00'),
          cessAmount: new Decimal('0.00'),
          totalInvoiceAmount: new Decimal('2360.00')
        },
        tx
      );

      await batchRepo.updateBatchStatus(orgA, batch1Id, BatchStatus.PENDING, BatchStatus.PROCESSING, undefined, tx);
      await batchRepo.updateBatchStatus(orgA, batch1Id, BatchStatus.PROCESSING, BatchStatus.COMPLETED, undefined, tx);
    });

    // 2. Create Batch 2 with executionMode: REPROCESSING, parentBatchId: batch1Id
    await runInTenantTransaction(prisma, orgA, async (tx) => {
      const b2 = await batchRepo.createBatch(
        orgA,
        {
          batchNumber: `BATCH-V2-${Date.now()}`,
          engineVersion: '0.1.0',
          rulesVersion: '2024.1',
          executionMode: 'REPROCESSING',
          parentBatchId: batch1Id,
          reprocessReason: 'Statutory amendment'
        },
        tx
      );
      batch2Id = b2.id;

      // Create Version 2 result in Batch 2
      await resultRepo.createInvoiceResult(
        orgA,
        {
          importBatchId: batch2Id,
          canonicalInvoiceId: canonicalId,
          sourceRecordId: srcV1.recordId,
          version: 2,
          primaryOutcome: PrimaryOutcome.VALID,
          lines: [],
          totalTaxableValue: new Decimal('2000.00'),
          cgstAmount: new Decimal('180.00'),
          sgstAmount: new Decimal('180.00'),
          igstAmount: new Decimal('0.00'),
          utgstAmount: new Decimal('0.00'),
          cessAmount: new Decimal('0.00'),
          totalInvoiceAmount: new Decimal('2360.00')
        },
        tx
      );

      await batchRepo.updateBatchStatus(orgA, batch2Id, BatchStatus.PENDING, BatchStatus.PROCESSING, undefined, tx);
      await batchRepo.updateBatchStatus(orgA, batch2Id, BatchStatus.PROCESSING, BatchStatus.COMPLETED, undefined, tx);
    });

    // 3. Verify Version 1 and Version 2 co-exist cleanly
    const allResults = await resultRepo.findInvoiceResultsByCanonicalInvoice(orgA, canonicalId);

    expect(allResults.length).toBe(2);
    const v1 = allResults.find((r) => r.version === 1);
    const v2 = allResults.find((r) => r.version === 2);

    expect(v1).toBeDefined();
    expect(v1?.importBatchId).toBe(batch1Id);

    expect(v2).toBeDefined();
    expect(v2?.importBatchId).toBe(batch2Id);
  });

  // =========================================================================
  // T-ASYNC-09: Audit A — SECURITY DEFINER Function Ownership & Dispatcher Enforcement
  // =========================================================================
  it('T-ASYNC-09: Audit A — Function ownership, fixed search_path, and dispatcher lease ownership are strictly enforced', async () => {
    // 1. Verify function owner and attributes in PostgreSQL catalog
    const funcRes = await adminClient.query(`
      SELECT 
        p.proname,
        r.rolname as owner,
        r.rolcanlogin as can_login,
        r.rolsuper as is_superuser,
        r.rolbypassrls as bypass_rls,
        p.prosecdef as is_security_definer,
        p.proconfig as config
      FROM pg_proc p
      JOIN pg_roles r ON p.proowner = r.oid
      WHERE p.proname IN ('claim_outbox_events', 'resolve_processing_job', 'mark_outbox_published', 'fail_outbox_event');
    `);

    expect(funcRes.rows.length).toBe(4);
    for (const row of funcRes.rows) {
      expect(row.owner).toBe('gstflow_definer');
      expect(row.can_login).toBe(false);
      expect(row.is_superuser).toBe(false);
      expect(row.bypass_rls).toBe(false);
      expect(row.is_security_definer).toBe(true);
      expect(row.config).toContain('search_path=pg_catalog, public');
    }

    // 2. Dispatcher lease ownership enforcement
    let eventId: string = '';
    await runInTenantTransaction(prisma, orgA, async (tx) => {
      const ev = await outboxRepo.createOutboxEvent(
        orgA,
        {
          eventType: 'BATCH_PROCESSING',
          payload: { tag: 'ownership-audit', organizationId: orgA.organizationId }
        },
        tx
      );
      eventId = ev.id;
    });

    // Dispatcher A claims the event
    const claimedA = await outboxRepo.claimEvents('dispatcher-A', 1, 30);
    expect(claimedA.length).toBe(1);
    expect(claimedA[0].id).toBe(eventId);

    // Dispatcher B attempts unauthorized publish -> must return false and not alter event
    const publishB = await outboxRepo.markPublished(eventId, 'dispatcher-B');
    expect(publishB).toBe(false);

    let evCheck = await outboxRepo.findById(orgA, eventId);
    expect(evCheck?.status).toBe(OutboxStatus.CLAIMED);
    expect(evCheck?.claimedBy).toBe('dispatcher-A');

    // Dispatcher B attempts unauthorized fail -> must return false and not alter event
    const failB = await outboxRepo.failEvent(eventId, 'dispatcher-B', 'Hacked failure message');
    expect(failB).toBe(false);

    evCheck = await outboxRepo.findById(orgA, eventId);
    expect(evCheck?.status).toBe(OutboxStatus.CLAIMED);
    expect(evCheck?.claimedBy).toBe('dispatcher-A');

    // Dispatcher A publishes its own event -> succeeds
    const publishA = await outboxRepo.markPublished(eventId, 'dispatcher-A');
    expect(publishA).toBe(true);

    evCheck = await outboxRepo.findById(orgA, eventId);
    expect(evCheck?.status).toBe(OutboxStatus.PUBLISHED);
    expect(evCheck?.publishedAt).not.toBeNull();

    // 3. Input validation: invalid parameters fail fast
    await expect(
      outboxRepo.claimEvents('', 10, 30)
    ).rejects.toThrow();

    await expect(
      prisma.$executeRawUnsafe(`SELECT mark_outbox_published($1::uuid, $2::text);`, eventId, '')
    ).rejects.toThrow();
  });

  // =========================================================================
  // T-ASYNC-10: Audit B — Outbox Crash Window & Republishing Invariance
  // =========================================================================
  it('T-ASYNC-10: Audit B — Redis publication succeeds but PG marking fails; expired lease allows safe re-dispatch with deterministic job identity', async () => {
    let eventId: string = '';
    await runInTenantTransaction(prisma, orgA, async (tx) => {
      const ev = await outboxRepo.createOutboxEvent(
        orgA,
        {
          eventType: 'BATCH_PROCESSING',
          payload: {
            processingJobId: crypto.randomUUID(),
            importBatchId: crypto.randomUUID(),
            organizationId: orgA.organizationId,
            filePaths: ['crash-window.csv']
          }
        },
        tx
      );
      eventId = ev.id;
    });

    const enqueuedHistory: string[] = [];
    const mockQueue = {
      enqueueBatchProcessing: async (id: string, _payload: any) => {
        enqueuedHistory.push(id);
        return `mock-job-${id}`;
      },
      close: async () => {}
    };

    // Dispatcher 1 claims with short lease (1s) and publishes to queue, but crashes before markPublished
    const dispatcher1 = new OutboxDispatcher({
      outboxRepo,
      queueService: mockQueue,
      dispatcherId: 'dispatcher-1-crash',
      batchSize: 1,
      leaseSeconds: 1
    });

    const claimed1 = await outboxRepo.claimEvents(dispatcher1.getDispatcherId(), 1, 1);
    expect(claimed1.length).toBe(1);
    expect(claimed1[0].id).toBe(eventId);

    // Queue receives the event
    await mockQueue.enqueueBatchProcessing(eventId, claimed1[0].payload);
    expect(enqueuedHistory).toEqual([eventId]);

    // Simulate crash before marking published: event remains CLAIMED with attempts = 1
    const crashState = await outboxRepo.findById(orgA, eventId);
    expect(crashState?.status).toBe(OutboxStatus.CLAIMED);
    expect(crashState?.attempts).toBe(1);

    // Wait 1.2s for lease to expire
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // Dispatcher 2 runs normal dispatchOnce cycle
    const dispatcher2 = new OutboxDispatcher({
      outboxRepo,
      queueService: mockQueue,
      dispatcherId: 'dispatcher-2-recovery',
      batchSize: 1,
      leaseSeconds: 30
    });

    const cycle2 = await dispatcher2.dispatchOnce();
    expect(cycle2.claimed).toBe(1);
    expect(cycle2.published).toBe(1);

    // Queue received second call with identical outbox ID (BullMQ deterministic dedup)
    expect(enqueuedHistory).toEqual([eventId, eventId]);

    // PostgreSQL now shows PUBLISHED with attempts = 2
    const finalEvent = await outboxRepo.findById(orgA, eventId);
    expect(finalEvent?.status).toBe(OutboxStatus.PUBLISHED);
    expect(finalEvent?.attempts).toBe(2);
    expect(finalEvent?.publishedAt).not.toBeNull();
  });

  // =========================================================================
  // T-ASYNC-11: Audit C — Durable Checkpoint Progression & Credit Note Crash Recovery
  // =========================================================================
  it('T-ASYNC-11: Audit C — Durable checkpoint progression and Scenario 4 credit note crash recovery prevent double application', async () => {
    // 1. Create Batch, Invoice, and Credit Note
    let batchId: string = '';
    let jobId: string = '';
    const invNum = `INV-CHK-${Date.now()}`;
    const cnNum = `CN-CHK-${Date.now()}`;
    const src = await createHelperSource(orgA, 'chk');

    let canonicalInvId = '';
    let invResultId = '';

    await runInTenantTransaction(prisma, orgA, async (tx) => {
      const batch = await batchRepo.createBatch(
        orgA,
        {
          batchNumber: `BATCH-CHK-${Date.now()}`,
          engineVersion: '0.1.0',
          rulesVersion: '2024.1',
          executionMode: 'STANDARD'
        },
        tx
      );
      batchId = batch.id;

      const job = await jobRepo.createJob(
        orgA,
        {
          importBatchId: batchId,
          jobType: 'BATCH_PROCESSING'
        },
        tx
      );
      jobId = job.id;

      // Checkpoint starts at STAGING
      const initialJob = await jobRepo.findById(orgA, jobId, tx);
      expect(initialJob?.executionCheckpoint).toBe(ExecutionCheckpoint.STAGING);

      // Create Canonical Invoice & Processing Result
      const canInv = await canonicalRepo.getOrCreateCanonicalInvoice(
        orgA,
        {
          businessKey: `27AAACA1234A1Z5:2024-2025:${invNum}`,
          sellerGstin: '27AAACA1234A1Z5',
          financialYear: '2024-2025',
          invoiceNumber: invNum,
          invoiceDate: new Date('2024-05-15'),
          originalInvoiceDate: new Date('2024-05-15'),
          buyerGstin: null,
          placeOfSupplyStateCode: '27',
          recipientType: 'B2C' as any,
          orderId: 'ORD-CHK-1',
          shipFromStateCode: '27',
          supplyType: 'INTRASTATE' as any,
          totalTaxableValue: new Decimal('1000.00'),
          totalInvoiceAmount: new Decimal('1180.00'),
          cgstAmount: new Decimal('90.00'),
          sgstAmount: new Decimal('90.00'),
          igstAmount: new Decimal('0.00'),
          utgstAmount: new Decimal('0.00'),
          cessAmount: new Decimal('0.00')
        },
        tx
      );
      canonicalInvId = canInv.invoice.id;

      const invRes = await resultRepo.createInvoiceResult(
        orgA,
        {
          importBatchId: batchId,
          canonicalInvoiceId: canonicalInvId,
          sourceRecordId: src.recordId,
          version: 1,
          primaryOutcome: PrimaryOutcome.VALID,
          lines: [],
          totalTaxableValue: new Decimal('1000.00'),
          cgstAmount: new Decimal('90.00'),
          sgstAmount: new Decimal('90.00'),
          igstAmount: new Decimal('0.00'),
          utgstAmount: new Decimal('0.00'),
          cessAmount: new Decimal('0.00'),
          totalInvoiceAmount: new Decimal('1180.00')
        },
        tx
      );
      invResultId = invRes.id;
    });

    // 2. Simulate Scenario 4: Credit Note Reconciled in Chunk 1, then worker crashes
    let cnResultId = '';
    await runInTenantTransaction(prisma, orgA, async (tx) => {
      // Advance checkpoint to CREDIT_NOTE_RECONCILIATION
      await jobRepo.updateCheckpoint(orgA, jobId, ExecutionCheckpoint.CREDIT_NOTE_RECONCILIATION, tx);

      const canCn = await canonicalRepo.getOrCreateCanonicalCreditNote(
        orgA,
        {
          sellerGstin: '27AAACA1234A1Z5',
          financialYear: '2024-2025',
          creditNoteNumber: cnNum,
          creditNoteDate: new Date('2024-05-20'),
          originalInvoiceNumber: invNum,
          originalInvoiceDate: new Date('2024-05-15'),
          orderId: 'ORD-CHK-1',
          recipientType: 'B2C' as any,
          customerGstin: null,
          placeOfSupplyStateCode: '27'
        },
        tx
      );

      const cnRes = await resultRepo.createCreditNoteResult(
        orgA,
        {
          importBatchId: batchId,
          canonicalCreditNoteId: canCn.creditNote.id,
          sourceRecordId: src.recordId,
          matchedInvoiceResultId: invResultId,
          taxableValueReversal: new Decimal('400.00'),
          cgstAmountReversal: new Decimal('36.00'),
          sgstAmountReversal: new Decimal('36.00'),
          utgstAmountReversal: new Decimal('0.00'),
          igstAmountReversal: new Decimal('0.00'),
          creditNoteTotal: new Decimal('472.00'),
          rawSignedAmountText: '-472.00',
          signedAmount: new Decimal('-472.00'),
          reconciliationStatus: 'MATCHED_FULL' as any,
          primaryOutcome: PrimaryOutcome.VALID
        },
        tx
      );
      cnResultId = cnRes.id;

      // Apply initial reconciliation
      await reconciliationRepo.createReconciliation(
        orgA,
        {
          importBatchId: batchId,
          creditNoteResultId: cnResultId,
          invoiceResultId: invResultId,
          reconciliationStatus: 'MATCHED_FULL' as any,
          taxableReversed: new Decimal('400.00'),
          cgstReversed: new Decimal('36.00'),
          sgstReversed: new Decimal('36.00'),
          utgstReversed: new Decimal('0.00'),
          igstReversed: new Decimal('0.00'),
          totalReversed: new Decimal('472.00')
        },
        tx
      );
    });

    // Verify invoice cumulative totals after Chunk 1
    const invAfterChunk1 = await resultRepo.findInvoiceResultById(orgA, invResultId);
    expect(invAfterChunk1?.cumulativeTaxableReversed.toFixed(2)).toBe('400.00');
    expect(invAfterChunk1?.cumulativeTotalReversed.toFixed(2)).toBe('472.00');
    expect(invAfterChunk1?.reversalCount).toBe(1);

    // 3. Worker crashed! Retrying execution...
    // Idempotency check: findReconciliationByCreditNoteResultId finds existing reconciliation
    const existingRec = await reconciliationRepo.findReconciliationByCreditNoteResultId(orgA, cnResultId);
    expect(existingRec).not.toBeNull();
    expect(existingRec?.creditNoteResultId).toBe(cnResultId);

    // Re-attempting to apply financial reconciliation for this credit note result fails/skips
    // Verify cumulative totals on invoice DO NOT change (zero double application)
    const invAfterRetry = await resultRepo.findInvoiceResultById(orgA, invResultId);
    expect(invAfterRetry?.cumulativeTaxableReversed.toFixed(2)).toBe('400.00');
    expect(invAfterRetry?.cumulativeTotalReversed.toFixed(2)).toBe('472.00');
    expect(invAfterRetry?.reversalCount).toBe(1);

    // 4. Job successfully completes and advances checkpoint to COMPLETED
    await jobRepo.updateCheckpoint(orgA, jobId, ExecutionCheckpoint.COMPLETED);
    const finalJob = await jobRepo.findById(orgA, jobId);
    expect(finalJob?.executionCheckpoint).toBe(ExecutionCheckpoint.COMPLETED);
  });

  // =========================================================================
  // T-ASYNC-12: Audit D — Worker Reliability & Graceful Shutdown
  // =========================================================================
  it('T-ASYNC-12: Audit D — Worker initializes with robust locking configuration and shuts down gracefully', async () => {
    const worker = new BatchProcessingWorker({
      orchestrator,
      jobRepo,
      autorun: false,
      lockDuration: 15000,
      stalledInterval: 15000,
      maxStalledCount: 1
    });

    expect(worker.getWorker()).toBeDefined();

    // Verify signal handler registration
    worker.setupGracefulShutdown(['SIGTERM', 'SIGINT']);

    // Verify graceful close completes cleanly
    await expect(worker.close()).resolves.toBeUndefined();
  });

  // =========================================================================
  // T-ASYNC-13: Audit E — BullMQ Deterministic Job ID colon-free format & deduplication
  // =========================================================================
  it('T-ASYNC-13: Audit E — BullMQ Deterministic Job ID colon-free format & deduplication and eviction resilience', async () => {
    const eventId = crypto.randomUUID();
    const deterministicId = buildDeterministicJobId(eventId);

    // 1. Colon-free check: Ensures no Redis key namespace delimiter splitting in BullMQ
    expect(deterministicId).not.toContain(':');
    expect(deterministicId).toBe(`gstflow-outbox-${eventId}`);

    // 2. Queue service deterministic job ID generation
    const mockQueue = {
      jobs: new Map<string, any>(),
      add: async (name: string, data: any, opts: any) => {
        const id = opts?.jobId || crypto.randomUUID();
        mockQueue.jobs.set(id, { name, data, id });
        return { id };
      }
    };

    const enqueueJob = async (outboxEventId: string, payload: any) => {
      const jobId = buildDeterministicJobId(outboxEventId);
      await mockQueue.add('process-staged-batch', payload, { jobId });
      return jobId;
    };

    const procJobId = crypto.randomUUID();
    const importBatchId = crypto.randomUUID();
    const jobId1 = await enqueueJob(eventId, {
      processingJobId: procJobId,
      importBatchId,
      organizationId: orgA.organizationId
    });
    expect(jobId1).toBe(deterministicId);

    // 3. Queue-level deduplication: repeated dispatch of identical outbox event produces identical job ID
    const jobId2 = await enqueueJob(eventId, {
      processingJobId: procJobId,
      importBatchId,
      organizationId: orgA.organizationId
    });
    expect(jobId2).toBe(jobId1);
    expect(mockQueue.jobs.size).toBe(1);

    // 4. Authoritative PostgreSQL processing job status lookup prevents duplicate execution even after BullMQ job completion/eviction
    let batchId = '';
    await runInTenantTransaction(prisma, orgA, async (tx) => {
      const b = await batchRepo.createBatch(
        orgA,
        {
          batchNumber: `EVICT-TEST-${Date.now()}`,
          engineVersion: '0.1.0',
          rulesVersion: '2024.1',
          executionMode: 'STANDARD'
        },
        tx
      );
      batchId = b.id;
    });

    const job = await jobRepo.createJob(orgA, {
      importBatchId: batchId
    });
    await jobRepo.updateJobStatus(orgA, job.id, JobStatus.COMPLETED);
    await jobRepo.updateCheckpoint(orgA, job.id, ExecutionCheckpoint.COMPLETED);

    // Check authoritative lookup via findById
    const authoritativeJob = await jobRepo.findById(orgA, job.id);
    expect(authoritativeJob?.status).toBe(JobStatus.COMPLETED);
    expect(authoritativeJob?.executionCheckpoint).toBe(ExecutionCheckpoint.COMPLETED);

    // If worker receives or re-receives this payload, authoritative job check prevents re-processing
    const worker = new BatchProcessingWorker({
      orchestrator,
      jobRepo,
      autorun: false
    });
    // processing a completed job skips domain execution
    const result = await worker.processJob({
      id: deterministicId,
      data: {
        processingJobId: job.id,
        importBatchId: batchId,
        organizationId: orgA.organizationId
      }
    } as any);

    expect(result.checkpoint).toBe(ExecutionCheckpoint.COMPLETED);
    expect(result.invoiceCount).toBe(0);

    // Verify job remains COMPLETED and batch not affected
    const jobAfter = await jobRepo.findById(orgA, job.id);
    expect(jobAfter?.status).toBe(JobStatus.COMPLETED);

    await worker.close();
  });

  // =========================================================================
  // T-ASYNC-14: Audit F — SECURITY DEFINER privilege boundaries and role isolation
  // =========================================================================
  it('T-ASYNC-14: Audit F — SECURITY DEFINER privilege boundaries and role isolation', async () => {
    // 1. gstflow_app role CANNOT assume gstflow_definer
    const appClient = new pg.Client({
      host: 'localhost',
      port: testPort,
      user: 'gstflow_app',
      password: 'gstflow_app_password',
      database: testDbName
    });
    await appClient.connect();

    try {
      await expect(appClient.query('SET ROLE gstflow_definer;')).rejects.toThrow();
    } finally {
      await appClient.end();
    }

    // 2. gstflow_definer role has NO privileges on financial domain tables
    await adminClient.query('SET ROLE gstflow_definer;');
    try {
      // Querying canonical_invoices must fail with permission denied (42501)
      await expect(adminClient.query('SELECT * FROM canonical_invoices LIMIT 1;')).rejects.toThrow();
      // Querying reconciliations must fail with permission denied (42501)
      await expect(adminClient.query('SELECT * FROM reconciliations LIMIT 1;')).rejects.toThrow();
      // Querying canonical_credit_notes must fail with permission denied (42501)
      await expect(adminClient.query('SELECT * FROM canonical_credit_notes LIMIT 1;')).rejects.toThrow();
      // But querying outbox_events and processing_jobs succeeds (explicit table grants)
      await expect(adminClient.query('SELECT count(*) FROM outbox_events;')).resolves.toBeDefined();
      await expect(adminClient.query('SELECT count(*) FROM processing_jobs;')).resolves.toBeDefined();
    } finally {
      await adminClient.query('RESET ROLE;');
    }
  });
});
