import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import {
  PersistentPipelineOrchestrator,
  RunPersistentBatchInput,
  StageBatchInput,
  SourceFileNotFoundOrInaccessibleError,
  FileCorruptedOrMalformedError
} from '../../src/application/persistent-pipeline/index.js';
import {
  PrismaImportBatchRepository,
  PrismaSourceRecordRepository,
  PrismaTransactionManager,
  TenantContext,
  BatchStatus,
  runInTenantTransaction
} from '../../src/repositories/index.js';

describe('Phase 3B.4.2: Persistent Source Staging PostgreSQL Integration Suite', () => {
  let pgServer: any;
  let adminClient: pg.Client;
  let prisma: PrismaClient;

  let batchRepo: PrismaImportBatchRepository;
  let sourceRecordRepo: PrismaSourceRecordRepository;
  let txManager: PrismaTransactionManager;
  let orchestrator: PersistentPipelineOrchestrator;

  const testDbName = 'gstflow_phase3b42_test_db';
  const testPort = 54338;
  const dataDir = path.resolve('.pgdata_phase3b42');

  const orgA: TenantContext = { organizationId: crypto.randomUUID() };
  const orgB: TenantContext = { organizationId: crypto.randomUUID() };

  const syntheticCreditNotesPath = path.resolve(
    __dirname,
    '../../GSTFlow_Synthetic_Test_Suite/amazon/synthetic_amazon_credit_notes.csv'
  );

  const testUploadsDir = path.resolve('.test_temp_uploads_pg_staging');

  beforeAll(async () => {
    if (!fs.existsSync(testUploadsDir)) {
      fs.mkdirSync(testUploadsDir, { recursive: true });
    }

    if (fs.existsSync(dataDir)) {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch {
        // Suppress initial unlink error
      }
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
        ('${orgA.organizationId}', 'Staging Test Org A', 'AAACA1234A', 72, NOW(), NOW()),
        ('${orgB.organizationId}', 'Staging Test Org B', 'AAACB5678B', 72, NOW(), NOW());
    `);

    // 5. Connect Prisma as restricted application user gstflow_app
    const databaseUrl = `postgresql://gstflow_app:gstflow_app_password@localhost:${testPort}/${testDbName}`;
    prisma = new PrismaClient({
      datasources: {
        db: { url: databaseUrl }
      }
    });
    await prisma.$connect();

    batchRepo = new PrismaImportBatchRepository(prisma);
    sourceRecordRepo = new PrismaSourceRecordRepository(prisma);
    txManager = new PrismaTransactionManager(prisma);

    orchestrator = new PersistentPipelineOrchestrator({
      importBatchRepo: batchRepo,
      sourceRecordRepo,
      transactionManager: txManager,
      stagingChunkSize: 200,
      allowedUploadDir: path.resolve('.')
    });
  }, 60000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (adminClient) await adminClient.end();
    if (pgServer) {
      await pgServer.stop();
    }
    if (fs.existsSync(testUploadsDir)) {
      fs.rmSync(testUploadsDir, { recursive: true, force: true });
    }
  }, 30000);

  it('1. Successfully streams and stages synthetic CSV records into PostgreSQL with chunking', async () => {
    // 1. Create a batch first
    const batch = await batchRepo.createBatch(orgA, {
      batchNumber: 'BATCH-STAGING-001',
      engineVersion: '0.1.0',
      rulesVersion: '2024.1',
      executionMode: 'AUTOMATED'
    });

    const stagingInput: StageBatchInput = {
      batchId: batch.id,
      filePaths: [syntheticCreditNotesPath],
      chunkSize: 250
    };

    const result = await orchestrator.stageBatch(orgA, stagingInput);

    expect(result.success).toBe(true);
    expect(result.batch.id).toBe(batch.id);
    expect(result.filesStaged.length).toBe(1);
    expect(result.totalRecordsInserted).toBeGreaterThan(0);
    expect(result.totalRecordsSkipped).toBe(0);

    const stagedFile = result.filesStaged[0];
    expect(stagedFile.sourceFileId).toBeDefined();
    expect(stagedFile.fileFingerprint).toHaveLength(64);
    expect(stagedFile.totalPhysicalLines).toBeGreaterThan(0);

    // Verify in PostgreSQL directly within tenant context
    const pgFile = await runInTenantTransaction(prisma, orgA, async (tx) => {
      return await tx.sourceFile.findUnique({
        where: { id: stagedFile.sourceFileId }
      });
    });
    expect(pgFile).not.toBeNull();
    expect(pgFile?.organizationId).toBe(orgA.organizationId);
    expect(pgFile?.totalPhysicalLines).toBe(stagedFile.totalPhysicalLines);

    // Verify association in BatchSourceFile
    const batchFileLink = await runInTenantTransaction(prisma, orgA, async (tx) => {
      return await tx.batchSourceFile.findFirst({
        where: {
          importBatchId: batch.id,
          sourceFileId: stagedFile.sourceFileId
        }
      });
    });
    expect(batchFileLink).not.toBeNull();
    expect(batchFileLink?.fileStatus).toBe('COMPLETED');

    // Verify source records count in PostgreSQL
    const recordCount = await runInTenantTransaction(prisma, orgA, async (tx) => {
      return await tx.sourceRecord.count({
        where: {
          sourceFileId: stagedFile.sourceFileId,
          organizationId: orgA.organizationId
        }
      });
    });
    expect(recordCount).toBe(result.totalRecordsInserted);

    // Verify raw payload preservation on a sample record
    const sampleRecord = await runInTenantTransaction(prisma, orgA, async (tx) => {
      return await tx.sourceRecord.findFirst({
        where: { sourceFileId: stagedFile.sourceFileId }
      });
    });
    expect(sampleRecord).not.toBeNull();
    expect(sampleRecord?.rawPayload).toBeTypeOf('object');
    expect(sampleRecord?.physicalLineNumber).toBe(2); // Line 1 is header
  });

  it('2. Enforces PostgreSQL RLS tenant isolation across staged source files and records', async () => {
    // Org B queries all source files and records
    const orgBFiles = await runInTenantTransaction(prisma, orgB, async (tx) => {
      return await tx.sourceFile.findMany();
    });
    expect(orgBFiles.length).toBe(0);

    const orgBRecords = await runInTenantTransaction(prisma, orgB, async (tx) => {
      return await tx.sourceRecord.findMany();
    });
    expect(orgBRecords.length).toBe(0);

    const orgBBatchFiles = await runInTenantTransaction(prisma, orgB, async (tx) => {
      return await tx.batchSourceFile.findMany();
    });
    expect(orgBBatchFiles.length).toBe(0);
  });

  it('3. Cross-tenant fingerprint isolation allows Org B to stage the identical file independently', async () => {
    const batchB = await batchRepo.createBatch(orgB, {
      batchNumber: 'BATCH-STAGING-ORGB-001',
      engineVersion: '0.1.0',
      rulesVersion: '2024.1',
      executionMode: 'AUTOMATED'
    });

    const stagingInput: StageBatchInput = {
      batchId: batchB.id,
      filePaths: [syntheticCreditNotesPath],
      chunkSize: 300
    };

    const resultB = await orchestrator.stageBatch(orgB, stagingInput);

    expect(resultB.success).toBe(true);
    expect(resultB.filesStaged.length).toBe(1);
    expect(resultB.totalRecordsInserted).toBeGreaterThan(0);

    // Org B file should have a distinct ID from Org A's file
    const stagedFileB = resultB.filesStaged[0];
    const orgAFiles = await runInTenantTransaction(prisma, orgA, async (tx) => {
      return await tx.sourceFile.findMany();
    });
    expect(orgAFiles.length).toBe(1);
    expect(orgAFiles[0].id).not.toBe(stagedFileB.sourceFileId);

    // Verify Org B source file belongs to Org B in PostgreSQL
    const pgFileB = await runInTenantTransaction(prisma, orgB, async (tx) => {
      return await tx.sourceFile.findUnique({
        where: { id: stagedFileB.sourceFileId }
      });
    });
    expect(pgFileB).not.toBeNull();
    expect(pgFileB?.organizationId).toBe(orgB.organizationId);
    expect(pgFileB?.fileFingerprint).toBe(orgAFiles[0].fileFingerprint); // Same hash, isolated tenants
  });

  it('4. Re-uploading identical file in the same tenant reuses existing file and skips duplicate records', async () => {
    const batchA2 = await batchRepo.createBatch(orgA, {
      batchNumber: 'BATCH-STAGING-REUPLOAD-002',
      engineVersion: '0.1.0',
      rulesVersion: '2024.1',
      executionMode: 'AUTOMATED'
    });

    const stagingInput: StageBatchInput = {
      batchId: batchA2.id,
      filePaths: [syntheticCreditNotesPath],
      chunkSize: 250
    };

    const initialRecordCount = await runInTenantTransaction(prisma, orgA, async (tx) => {
      return await tx.sourceRecord.count({ where: { organizationId: orgA.organizationId } });
    });

    const result = await orchestrator.stageBatch(orgA, stagingInput);

    expect(result.success).toBe(true);
    expect(result.filesStaged.length).toBe(1);
    expect(result.totalRecordsInserted).toBe(0); // 0 inserted
    expect(result.totalRecordsSkipped).toBeGreaterThan(0); // all skipped

    // Total records in PostgreSQL for Org A must remain identical
    const finalRecordCount = await runInTenantTransaction(prisma, orgA, async (tx) => {
      return await tx.sourceRecord.count({ where: { organizationId: orgA.organizationId } });
    });
    expect(finalRecordCount).toBe(initialRecordCount);

    // But BatchSourceFile must be linked for batchA2
    const batchLink = await runInTenantTransaction(prisma, orgA, async (tx) => {
      return await tx.batchSourceFile.findFirst({
        where: {
          importBatchId: batchA2.id,
          sourceFileId: result.filesStaged[0].sourceFileId
        }
      });
    });
    expect(batchLink).not.toBeNull();
    expect(batchLink?.fileStatus).toBe('COMPLETED');
  });

  it('5. ON CONFLICT DO NOTHING idempotency: bulkInsertSourceRecords safely handles duplicates without throwing', async () => {
    // Lookup Org A's source file
    const file = await runInTenantTransaction(prisma, orgA, async (tx) => {
      return await tx.sourceFile.findFirst({
        where: { organizationId: orgA.organizationId }
      });
    });
    expect(file).not.toBeNull();

    // Call bulkInsertSourceRecords directly with duplicate line 2
    const duplicateRecords = [
      {
        physicalLineNumber: 2,
        logicalRecordNumber: 1,
        recordType: 'CREDIT_NOTE' as any,
        rawPayload: { test: 'duplicate' }
      }
    ];

    const bulkResult = await sourceRecordRepo.bulkInsertSourceRecords(
      orgA,
      file!.id,
      duplicateRecords
    );

    expect(bulkResult.insertedCount).toBe(0);
    expect(bulkResult.skippedCount).toBe(1);
    expect(bulkResult.totalProvided).toBe(1);
  });

  it('6. Incomplete source file prevention: non-existent file or corrupted file fails cleanly', async () => {
    const batch = await batchRepo.createBatch(orgA, {
      batchNumber: 'BATCH-FAIL-001',
      engineVersion: '0.1.0',
      rulesVersion: '2024.1'
    });

    // 1. Non-existent file
    await expect(
      orchestrator.stageBatch(orgA, {
        batchId: batch.id,
        filePaths: ['non_existent_file.csv']
      })
    ).rejects.toThrow(SourceFileNotFoundOrInaccessibleError);

    // 2. Corrupted / unparseable CSV
    const batch2 = await batchRepo.createBatch(orgA, {
      batchNumber: 'BATCH-FAIL-002',
      engineVersion: '0.1.0',
      rulesVersion: '2024.1'
    });

    const malformedCsv = path.join(testUploadsDir, 'malformed.csv');
    // Mismatched unclosed quote to cause parser error
    fs.writeFileSync(malformedCsv, 'col1,col2\n"open quote without closing,value\n', 'utf8');

    await expect(
      orchestrator.stageBatch(orgA, {
        batchId: batch2.id,
        filePaths: [malformedCsv]
      })
    ).rejects.toThrow(FileCorruptedOrMalformedError);
  });

  it('7. End-to-end persistent orchestration: runBatch with stageSourceRecords: true stages and executes', async () => {
    const input: RunPersistentBatchInput = {
      batchNumber: 'BATCH-E2E-STAGE-001',
      engineVersion: '0.1.0',
      rulesVersion: '2024.1',
      filePaths: [syntheticCreditNotesPath],
      stageSourceRecords: true,
      stagingChunkSize: 300
    };

    const result = await orchestrator.runBatch(orgA, input);

    expect(result.success).toBe(true);
    expect(result.batch.batchNumber).toBe('BATCH-E2E-STAGE-001');
    expect(result.batch.status).toBe(BatchStatus.COMPLETED);
    expect(result.batch.completedAt).toBeInstanceOf(Date);
    expect(result.report).toBeDefined();

    // Verify source records exist for this batch's associated source file
    const batchFileLink = await runInTenantTransaction(prisma, orgA, async (tx) => {
      return await tx.batchSourceFile.findFirst({
        where: { importBatchId: result.batch.id }
      });
    });
    expect(batchFileLink).not.toBeNull();
    expect(batchFileLink?.fileStatus).toBe('COMPLETED');

    const stagedRecordsCount = await runInTenantTransaction(prisma, orgA, async (tx) => {
      return await tx.sourceRecord.count({
        where: {
          sourceFileId: batchFileLink!.sourceFileId,
          organizationId: orgA.organizationId
        }
      });
    });
    expect(stagedRecordsCount).toBeGreaterThan(0);
  });

  it('8. Transaction-local tenant context does not leak between connections or after transaction completion', async () => {
    // Run inside Org A transaction
    await runInTenantTransaction(prisma, orgA, async (tx) => {
      const res = await tx.$queryRaw<any[]>`
        SELECT current_setting('app.current_organization_id', true) as org_id
      `;
      expect(res[0].org_id).toBe(orgA.organizationId);
    });

    // Query directly on prisma outside transaction
    const resOutside = await prisma.$queryRaw<any[]>`
      SELECT NULLIF(current_setting('app.current_organization_id', true), '') as org_id
    `;
    expect(resOutside[0].org_id).toBeNull();
  });

  it('9. Recovers an incomplete source file and avoids treating it as completed', async () => {
    // Create a temporary file with 10 records
    const testFile = path.join(testUploadsDir, 'interrupted_recovery.csv');
    let csv = 'Order ID,SKU,Taxable Value\n';
    for (let i = 1; i <= 10; i++) {
      csv += `ORD-${i},SKU-${i},${i * 100}.00\n`;
    }
    fs.writeFileSync(testFile, csv, 'utf8');

    const stagingService = orchestrator.getSourceStagingService()!;
    const { fingerprint, fileSizeBytes } = await stagingService.computeFileFingerprint(testFile);

    // Simulate an interrupted/failed previous upload:
    // Create SourceFile with totalPhysicalLines: 0
    const incompleteFile = await sourceRecordRepo.createSourceFile(orgA, {
      fileName: 'interrupted_recovery.csv',
      fileFingerprint: fingerprint,
      fileSizeBytes,
      storageUri: testFile,
      sourceReportType: 'UNKNOWN',
      totalPhysicalLines: 0
    });

    // Insert only first 3 records
    await sourceRecordRepo.bulkInsertSourceRecords(orgA, incompleteFile.id, [
      { physicalLineNumber: 2, logicalRecordNumber: 1, recordType: 'OUTWARD_SUPPLY' as any, rawPayload: { test: '1' } },
      { physicalLineNumber: 3, logicalRecordNumber: 2, recordType: 'OUTWARD_SUPPLY' as any, rawPayload: { test: '2' } },
      { physicalLineNumber: 4, logicalRecordNumber: 3, recordType: 'OUTWARD_SUPPLY' as any, rawPayload: { test: '3' } }
    ]);

    const batchPrev = await batchRepo.createBatch(orgA, {
      batchNumber: 'BATCH-FAILED-INTERRUPTED',
      engineVersion: '0.1.0',
      rulesVersion: '2024.1'
    });
    await batchRepo.associateSourceFile(orgA, batchPrev.id, incompleteFile.id, 'FAILED' as any);

    // Now attempt to stage into a new batch
    const batchNew = await batchRepo.createBatch(orgA, {
      batchNumber: 'BATCH-RECOVERED-001',
      engineVersion: '0.1.0',
      rulesVersion: '2024.1'
    });

    const recoveryResult = await orchestrator.stageBatch(orgA, {
      batchId: batchNew.id,
      filePaths: [testFile],
      chunkSize: 5
    });

    expect(recoveryResult.success).toBe(true);
    expect(recoveryResult.filesStaged[0].fileStatus).toBe('COMPLETED');
    expect(recoveryResult.filesStaged[0].totalPhysicalLines).toBe(11); // 1 header + 10 rows
    expect(recoveryResult.filesStaged[0].recordsInserted).toBe(7); // 3 were skipped, 7 newly inserted
    expect(recoveryResult.filesStaged[0].recordsSkipped).toBe(3);

    // Verify all 10 records now exist in PostgreSQL
    const totalRecords = await runInTenantTransaction(prisma, orgA, async (tx) => {
      return await tx.sourceRecord.count({
        where: { sourceFileId: incompleteFile.id, organizationId: orgA.organizationId }
      });
    });
    expect(totalRecords).toBe(10);
  });

  it('10. Rejects staging into COMPLETED or FAILED batches (Batch Lifecycle Integrity)', async () => {
    const testFile = path.join(testUploadsDir, 'lifecycle_test.csv');
    fs.writeFileSync(testFile, 'ColA,ColB\n1,2\n', 'utf8');

    const completedBatch = await batchRepo.createBatch(orgA, {
      batchNumber: 'BATCH-LIFECYCLE-COMPLETED',
      engineVersion: '0.1.0',
      rulesVersion: '2024.1'
    });
    await batchRepo.updateBatchStatus(orgA, completedBatch.id, BatchStatus.PENDING, BatchStatus.PROCESSING);
    await batchRepo.updateBatchStatus(orgA, completedBatch.id, BatchStatus.PROCESSING, BatchStatus.COMPLETED);

    await expect(
      orchestrator.stageBatch(orgA, {
        batchId: completedBatch.id,
        filePaths: [testFile]
      })
    ).rejects.toThrow();
  });

  it('11. Representative large file staging performance telemetry', async () => {
    const syntheticB2BPath = path.resolve(
      __dirname,
      '../../GSTFlow_Synthetic_Test_Suite/amazon/synthetic_amazon_mtr_b2b.csv'
    );

    const batch = await batchRepo.createBatch(orgA, {
      batchNumber: 'BATCH-PERF-5K-001',
      engineVersion: '0.1.0',
      rulesVersion: '2024.1'
    });

    const startMemory = process.memoryUsage().heapUsed;
    const startTime = Date.now();

    const result = await orchestrator.stageBatch(orgA, {
      batchId: batch.id,
      filePaths: [syntheticB2BPath],
      chunkSize: 1000
    });

    const totalTimeMs = Date.now() - startTime;
    const endMemory = process.memoryUsage().heapUsed;

    expect(result.success).toBe(true);
    expect(result.totalRecordsInserted).toBe(5000);

    const staged = result.filesStaged[0];
    console.log('[PERFORMANCE TELEMETRY - 5K B2B STAGING]:', {
      fileSizeBytes: Number(staged.fileSizeBytes),
      recordCount: staged.parsedLogicalRecords,
      hashingMs: staged.timings.hashingMs,
      parsingMs: staged.timings.parsingMs,
      insertionMs: staged.timings.insertionMs,
      totalDurationMs: totalTimeMs,
      throughputRecordsPerSec: Math.round((staged.parsedLogicalRecords / totalTimeMs) * 1000),
      heapDeltaMB: Math.round(((endMemory - startMemory) / 1024 / 1024) * 100) / 100
    });
  });
});
