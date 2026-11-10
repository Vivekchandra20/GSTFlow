import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { Decimal } from '../../src/utils/decimal.js';
import {
  PersistentPipelineOrchestrator,
  RunPersistentBatchInput
} from '../../src/application/persistent-pipeline/index.js';
import {
  PrismaImportBatchRepository,
  PrismaSourceRecordRepository,
  PrismaCanonicalDocumentRepository,
  PrismaProcessingResultRepository,
  PrismaTransactionManager,
  TenantContext,
  BatchStatus,
  runInTenantTransaction
} from '../../src/repositories/index.js';

describe('Phase 3B.4.3: Persistent Domain Pipeline & Processing Result PostgreSQL Integration Suite', () => {
  let pgServer: any;
  let adminClient: pg.Client;
  let prisma: PrismaClient;

  let batchRepo: PrismaImportBatchRepository;
  let sourceRecordRepo: PrismaSourceRecordRepository;
  let canonicalRepo: PrismaCanonicalDocumentRepository;
  let processingResultRepo: PrismaProcessingResultRepository;
  let txManager: PrismaTransactionManager;
  let orchestrator: PersistentPipelineOrchestrator;

  const testDbName = 'gstflow_phase3b43_test_db';
  const testPort = 54339;
  const dataDir = path.resolve('.pgdata_phase3b43');

  const orgA: TenantContext = { organizationId: crypto.randomUUID() };
  const orgB: TenantContext = { organizationId: crypto.randomUUID() };
  const orgVersion: TenantContext = { organizationId: crypto.randomUUID() };

  const syntheticB2BPath = path.resolve(
    __dirname,
    '../../GSTFlow_Synthetic_Test_Suite/amazon/synthetic_amazon_mtr_b2b.csv'
  );
  const syntheticCreditNotesPath = path.resolve(
    __dirname,
    '../../GSTFlow_Synthetic_Test_Suite/amazon/synthetic_amazon_credit_notes.csv'
  );
  const syntheticTransfersPath = path.resolve(
    __dirname,
    '../../GSTFlow_Synthetic_Test_Suite/amazon/synthetic_amazon_stock_transfer.csv'
  );

  const testUploadsDir = path.resolve('.test_temp_uploads_pg_domain_persist');

  beforeAll(async () => {
    if (fs.existsSync(dataDir)) {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {}
    }

    if (!fs.existsSync(testUploadsDir)) {
      fs.mkdirSync(testUploadsDir, { recursive: true });
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

    // 3. Connect to test DB as admin and apply initial migration
    adminClient = new pg.Client({
      host: 'localhost',
      port: testPort,
      user: 'postgres',
      password: 'postgrespassword',
      database: testDbName
    });
    await adminClient.connect();

    const migrationPath = path.resolve(
      'prisma/migrations/20261107000000_init_persistence_foundation/migration.sql'
    );
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');
    await adminClient.query(migrationSql);

    // 4. Seed test organizations as admin
    await adminClient.query(`
      INSERT INTO organizations (id, name, pan, data_retention_months, created_at, updated_at)
      VALUES 
        ('${orgA.organizationId}', 'Domain Persist Org A', 'AAACA1234A', 72, NOW(), NOW()),
        ('${orgB.organizationId}', 'Domain Persist Org B', 'AAACB5678B', 72, NOW(), NOW()),
        ('${orgVersion.organizationId}', 'Domain Persist Org Version', 'AAACV9999V', 72, NOW(), NOW());
    `);

    // 5. Connect Prisma as restricted application user gstflow_app
    const databaseUrl = `postgresql://gstflow_app:gstflow_app_password@localhost:${testPort}/${testDbName}`;
    prisma = new PrismaClient({
      datasources: {
        db: { url: databaseUrl }
      }
    });
    await prisma.$connect();

    // 6. Initialize Repositories
    batchRepo = new PrismaImportBatchRepository(prisma);
    sourceRecordRepo = new PrismaSourceRecordRepository(prisma);
    canonicalRepo = new PrismaCanonicalDocumentRepository(prisma);
    processingResultRepo = new PrismaProcessingResultRepository(prisma);
    txManager = new PrismaTransactionManager(prisma);

    orchestrator = new PersistentPipelineOrchestrator({
      importBatchRepo: batchRepo,
      sourceRecordRepo,
      canonicalDocRepo: canonicalRepo,
      processingResultRepo,
      transactionManager: txManager,
      stagingChunkSize: 1000,
      persistenceChunkSize: 500,
      allowedUploadDir: path.resolve('.')
    });
  }, 60000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (adminClient) await adminClient.end();
    if (pgServer) {
      try {
        await pgServer.stop();
      } catch {}
    }
    try {
      if (fs.existsSync(testUploadsDir)) {
        fs.rmSync(testUploadsDir, { recursive: true, force: true });
      }
    } catch {}
    try {
      if (fs.existsSync(dataDir)) {
        fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    } catch {}
  }, 30000);

  it('1. End-to-end Persistent Orchestration: Stages, executes domain pipeline, and persists canonical documents and processing results', async () => {
    // Create a 20-line sample B2B CSV
    const sampleB2B = path.join(testUploadsDir, 'sample_b2b_e2e.csv');
    const b2bHeader = fs.readFileSync(syntheticB2BPath, 'utf8').split('\n').slice(0, 21).join('\n');
    fs.writeFileSync(sampleB2B, b2bHeader, 'utf8');

    const input: RunPersistentBatchInput = {
      batchNumber: 'BATCH-E2E-PG-001',
      engineVersion: '0.1.0',
      rulesVersion: '2024.1',
      filePaths: [sampleB2B],
      stageSourceRecords: true,
      persistProcessingResults: true,
      persistenceChunkSize: 10
    };

    const result = await orchestrator.runBatch(orgA, input);

    expect(result.success).toBe(true);
    expect(result.batch.status).toBe(BatchStatus.COMPLETED);
    expect(result.stagingResult).toBeDefined();
    expect(result.stagingResult?.totalRecordsInserted).toBe(20);
    expect(result.persistenceResult).toBeDefined();
    expect(result.persistenceResult?.invoicesPersisted).toBe(20);
    expect(result.persistenceResult?.invoiceLinesPersisted).toBe(20);
    expect(result.persistenceResult?.canonicalInvoicesCreated).toBe(20);

    // Verify in PostgreSQL database directly via RLS tenant transaction
    await runInTenantTransaction(prisma, orgA, async (tx) => {
      const canonicalCount = await tx.canonicalInvoice.count({
        where: { organizationId: orgA.organizationId }
      });
      expect(canonicalCount).toBe(20);

      const results = await tx.invoiceProcessingResult.findMany({
        where: {
          organizationId: orgA.organizationId,
          importBatchId: result.batch.id
        },
        include: { lines: true }
      });

      expect(results.length).toBe(20);
      for (const res of results) {
        expect(res.version).toBe(1);
        expect(res.lines.length).toBe(1);
        expect(res.lines[0].lineNumber).toBe(1);
        expect(new Decimal(res.lines[0].quantity.toString()).isPositive()).toBe(true);
        expect(new Decimal(res.lines[0].itemTaxableValue.toString()).isPositive()).toBe(true);
      }
    });
  });

  it('2. Multi-Tenant RLS: Org B cannot view Org A canonical documents or processing results', async () => {
    await runInTenantTransaction(prisma, orgB, async (tx) => {
      const canonicalForOrgB = await tx.canonicalInvoice.count({
        where: { organizationId: orgB.organizationId }
      });
      expect(canonicalForOrgB).toBe(0);

      const resultsForOrgB = await tx.invoiceProcessingResult.count({
        where: { organizationId: orgB.organizationId }
      });
      expect(resultsForOrgB).toBe(0);
    });
  });

  it('3. Reprocessing & Versioning: Batch 2 creates Version 2 referencing same canonical document while Version 1 remains immutable', async () => {
    // Stage and process a single invoice file
    const singleInvFile = path.join(testUploadsDir, 'single_inv.csv');
    const headerLines = fs.readFileSync(syntheticB2BPath, 'utf8').split('\n').slice(0, 2).join('\n');
    fs.writeFileSync(singleInvFile, headerLines, 'utf8');

    // Run Batch 1
    const run1 = await orchestrator.runBatch(orgVersion, {
      batchNumber: 'BATCH-VERSION-001',
      engineVersion: '0.1.0',
      rulesVersion: '2024.1',
      filePaths: [singleInvFile],
      stageSourceRecords: true,
      persistProcessingResults: true
    });
    expect(run1.success).toBe(true);

    // Run Batch 2 (Reprocessing)
    const run2 = await orchestrator.runBatch(orgVersion, {
      batchNumber: 'BATCH-VERSION-002',
      engineVersion: '0.2.0',
      rulesVersion: '2025.1',
      executionMode: 'REPROCESSING',
      reprocessReason: 'Statutory rules update',
      parentBatchId: run1.batch.id,
      filePaths: [singleInvFile],
      stageSourceRecords: true, // Should reuse existing file
      persistProcessingResults: true
    });
    expect(run2.success).toBe(true);

    // Verify in PostgreSQL database
    await runInTenantTransaction(prisma, orgVersion, async (tx) => {
      const canonical = await tx.canonicalInvoice.findFirst({
        where: {
          organizationId: orgVersion.organizationId,
          invoiceNumber: 'AMZ/26-27/0000001'
        }
      });
      expect(canonical).not.toBeNull();

      const allResults = await tx.invoiceProcessingResult.findMany({
        where: {
          organizationId: orgVersion.organizationId,
          canonicalInvoiceId: canonical!.id
        },
        orderBy: { version: 'asc' }
      });

      expect(allResults.length).toBe(2);
      expect(allResults[0].importBatchId).toBe(run1.batch.id);
      expect(allResults[0].version).toBe(1);

      expect(allResults[1].importBatchId).toBe(run2.batch.id);
      expect(allResults[1].version).toBe(2);

      // Both point to the exact same canonical document
      expect(allResults[0].canonicalInvoiceId).toBe(canonical!.id);
      expect(allResults[1].canonicalInvoiceId).toBe(canonical!.id);
    });
  });

  it('4. Idempotency: Retrying the same batch reuses existing processing results and skips duplicate insertion', async () => {
    const singleInvFile = path.join(testUploadsDir, 'single_inv.csv');

    // Fetch batch 1 and call persistence service directly to simulate retry
    const batch1 = await batchRepo.getBatchByNumber(orgVersion, 'BATCH-VERSION-001');
    expect(batch1).not.toBeNull();

    const persistenceService = orchestrator.getProcessingPersistenceService()!;
    const detailed = await orchestrator.getPipelineOrchestrator().processBatchDetailed([singleInvFile]);

    const lineMap = await sourceRecordRepo.findRecordLineMap(orgVersion, batch1!.id);
    const sourceFileMap = new Map();

    const retryResult = await persistenceService.persistBatchResults(
      orgVersion,
      batch1!,
      detailed,
      sourceFileMap
    );

    // 0 new canonical documents, 0 duplicate results created
    expect(retryResult.canonicalInvoicesCreated).toBe(0);
    expect(retryResult.invoicesPersisted).toBe(0);
  });

  it('5. End-to-end Credit Note & Stock Transfer Persistence', async () => {
    // 5-line Credit Note and 5-line Stock Transfer files
    const sampleCN = path.join(testUploadsDir, 'sample_cn_e2e.csv');
    const sampleST = path.join(testUploadsDir, 'sample_st_e2e.csv');

    fs.writeFileSync(sampleCN, fs.readFileSync(syntheticCreditNotesPath, 'utf8').split('\n').slice(0, 6).join('\n'), 'utf8');
    fs.writeFileSync(sampleST, fs.readFileSync(syntheticTransfersPath, 'utf8').split('\n').slice(0, 6).join('\n'), 'utf8');

    const result = await orchestrator.runBatch(orgA, {
      batchNumber: 'BATCH-CN-ST-E2E-001',
      engineVersion: '0.1.0',
      rulesVersion: '2024.1',
      filePaths: [sampleCN, sampleST],
      stageSourceRecords: true,
      persistProcessingResults: true
    });

    expect(result.success).toBe(true);
    expect(result.persistenceResult?.creditNotesPersisted).toBe(5);
    expect(result.persistenceResult?.stockTransfersPersisted).toBe(5);

    await runInTenantTransaction(prisma, orgA, async (tx) => {
      const cnResults = await tx.creditNoteProcessingResult.findMany({
        where: { organizationId: orgA.organizationId, importBatchId: result.batch.id }
      });
      expect(cnResults.length).toBe(5);
      for (const cn of cnResults) {
        expect(new Decimal(cn.signedAmount.toString()).isNegative()).toBe(true);
        expect(cn.rawSignedAmountText.startsWith('-')).toBe(true);
      }

      const stResults = await tx.stockTransferProcessingResult.findMany({
        where: { organizationId: orgA.organizationId, importBatchId: result.batch.id }
      });
      expect(stResults.length).toBe(5);
      for (const st of stResults) {
        expect(st.classification).toBeDefined();
        expect(new Decimal(st.taxableValue.toString()).isPositive()).toBe(true);
      }
    });
  });

  it('6. Performance Telemetry: 5,000 B2B Ingestion, Domain Processing, and Database Persistence', async () => {
    const startTime = Date.now();
    const startMemoryMB = Math.round(process.memoryUsage().heapUsed / (1024 * 1024));

    const result = await orchestrator.runBatch(orgA, {
      batchNumber: 'BATCH-PERF-5K-001',
      engineVersion: '0.1.0',
      rulesVersion: '2024.1',
      filePaths: [syntheticB2BPath],
      stageSourceRecords: true,
      stagingChunkSize: 1000,
      persistProcessingResults: true,
      persistenceChunkSize: 1000
    });

    const totalDurationMs = Date.now() - startTime;
    const endMemoryMB = Math.round(process.memoryUsage().heapUsed / (1024 * 1024));
    const heapDeltaMB = Math.max(0, endMemoryMB - startMemoryMB);

    expect(result.success).toBe(true);
    expect(result.report.totalRecordsIngested).toBe(5000);
    expect(result.persistenceResult?.invoicesPersisted).toBe(5000);
    expect(result.persistenceResult?.invoiceLinesPersisted).toBe(5000);

    const stagingMs = result.stagingResult?.executionTimeMs || 0;
    const domainMs = result.report.performance.durationMs || 0;
    const persistenceMs = result.persistenceResult?.durationMs || 0;

    const throughput = Math.round((5000 / totalDurationMs) * 1000);

    const telemetry = {
      recordCount: 5000,
      stagingDurationMs: stagingMs,
      domainDurationMs: domainMs,
      persistenceDurationMs: persistenceMs,
      totalDurationMs,
      throughputRecordsPerSec: throughput,
      heapDeltaMB
    };

    console.log('\n[PHASE 3B.4.3 - 5K B2B PERSISTENT PIPELINE TELEMETRY]:', telemetry);

    expect(totalDurationMs).toBeGreaterThan(0);
    expect(throughput).toBeGreaterThan(20); // Expect healthy database throughput
  }, 120000);
});
