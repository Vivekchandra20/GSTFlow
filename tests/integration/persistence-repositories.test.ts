import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import {
  PrismaSourceRecordRepository,
  PrismaImportBatchRepository,
  TenantContext,
  RecordType,
  BatchStatus,
  FileBatchStatus,
  DuplicateSourceFileError,
  SourceFileNotFoundError,
  BatchNotFoundError,
  IllegalBatchStatusTransitionError,
  runInTenantTransaction
} from '../../src/repositories/index.js';

describe('Phase 3B.3.1: PostgreSQL Persistence Repositories & Security Integration Suite', () => {
  let pgServer: any;
  let adminClient: pg.Client;
  let prisma: PrismaClient;
  let sourceRepo: PrismaSourceRecordRepository;
  let batchRepo: PrismaImportBatchRepository;

  const testDbName = 'gstflow_repo_test_db';
  const testPort = 54334;
  const dataDir = path.resolve('.pgdata_phase3b31');

  const orgA: TenantContext = { organizationId: crypto.randomUUID() };
  const orgB: TenantContext = { organizationId: crypto.randomUUID() };

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

    // 3. Connect to test DB as admin and apply migration
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
        ('${orgA.organizationId}', 'Tenant A Corp', 'AAACA1234A', 72, NOW(), NOW()),
        ('${orgB.organizationId}', 'Tenant B Ltd', 'AAACB5678B', 72, NOW(), NOW());
    `);

    // 5. Connect Prisma as restricted application user gstflow_app
    const databaseUrl = `postgresql://gstflow_app:gstflow_app_password@localhost:${testPort}/${testDbName}`;
    prisma = new PrismaClient({
      datasources: {
        db: { url: databaseUrl }
      }
    });
    await prisma.$connect();

    sourceRepo = new PrismaSourceRecordRepository(prisma);
    batchRepo = new PrismaImportBatchRepository(prisma);
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
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {}
  });

  // ==========================================
  // REQUIREMENT 1: NEW SOURCE FILE INGESTION
  // ==========================================
  describe('1. New source file ingestion', () => {
    it('creates source file, retrieves by ID and fingerprint, and associates with batch', async () => {
      const file = await sourceRepo.createSourceFile(orgA, {
        fileName: 'Amazon_MTR_April_2026.csv',
        fileFingerprint: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        fileSizeBytes: 1048576n,
        storageUri: 's3://gstflow-vault/tenants/orgA/files/Amazon_MTR_April_2026.csv',
        reportPeriod: '2026-04',
        sourceReportType: 'AMAZON_MTR',
        totalPhysicalLines: 500
      });

      expect(file.id).toBeDefined();
      expect(file.organizationId).toBe(orgA.organizationId);
      expect(file.fileName).toBe('Amazon_MTR_April_2026.csv');
      expect(file.fileSizeBytes).toBe(1048576n);
      expect(file.totalPhysicalLines).toBe(500);

      // Verify retrieval by ID
      const byId = await sourceRepo.findSourceFileById(orgA, file.id);
      expect(byId).not.toBeNull();
      expect(byId?.id).toBe(file.id);

      // Verify retrieval by fingerprint
      const byFp = await sourceRepo.findSourceFileByFingerprint(
        orgA,
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      );
      expect(byFp).not.toBeNull();
      expect(byFp?.id).toBe(file.id);

      // Create import batch associating this file
      const batch = await batchRepo.createBatch(orgA, {
        batchNumber: 'BATCH-2026-04-001',
        engineVersion: '0.1.0',
        rulesVersion: '2026.1',
        sourceFileIds: [file.id]
      });

      expect(batch.id).toBeDefined();
      expect(batch.status).toBe(BatchStatus.PENDING);
      expect(batch.executionMode).toBe('STANDARD');

      const batchWithFiles = await batchRepo.getBatchById(orgA, batch.id);
      expect(batchWithFiles?.fileAssociations.length).toBe(1);
      expect(batchWithFiles?.fileAssociations[0].sourceFileId).toBe(file.id);
      expect(batchWithFiles?.fileAssociations[0].sourceFile.fileName).toBe(
        'Amazon_MTR_April_2026.csv'
      );
    });
  });

  // ==========================================
  // REQUIREMENT 2: DUPLICATE FILE FINGERPRINT
  // ==========================================
  describe('2. Duplicate file fingerprint', () => {
    it('rejects duplicate file upload with same fingerprint in same tenant', async () => {
      const fingerprint = 'dup_fingerprint_hash_11223344556677889900aabbccddeeff';

      await sourceRepo.createSourceFile(orgA, {
        fileName: 'First_Upload.csv',
        fileFingerprint: fingerprint,
        fileSizeBytes: 2048n,
        storageUri: 's3://vault/first.csv',
        sourceReportType: 'AMAZON_MTR'
      });

      await expect(
        sourceRepo.createSourceFile(orgA, {
          fileName: 'Duplicate_Upload.csv',
          fileFingerprint: fingerprint,
          fileSizeBytes: 2048n,
          storageUri: 's3://vault/dup.csv',
          sourceReportType: 'AMAZON_MTR'
        })
      ).rejects.toThrow(DuplicateSourceFileError);
    });

    it('permits identical fingerprint in a different tenant (tenant scoped)', async () => {
      const fingerprint = 'shared_fingerprint_across_tenants_1234567890';

      const fileA = await sourceRepo.createSourceFile(orgA, {
        fileName: 'TenantA_File.csv',
        fileFingerprint: fingerprint,
        fileSizeBytes: 4096n,
        storageUri: 's3://vault/a.csv',
        sourceReportType: 'AMAZON_MTR'
      });

      const fileB = await sourceRepo.createSourceFile(orgB, {
        fileName: 'TenantB_File.csv',
        fileFingerprint: fingerprint,
        fileSizeBytes: 4096n,
        storageUri: 's3://vault/b.csv',
        sourceReportType: 'AMAZON_MTR'
      });

      expect(fileA.id).not.toBe(fileB.id);
      expect(fileA.organizationId).toBe(orgA.organizationId);
      expect(fileB.organizationId).toBe(orgB.organizationId);
    });
  });

  // ==========================================
  // REQUIREMENT 3: DUPLICATE UPLOAD WITHOUT CREATING DUPLICATE RECORDS
  // ==========================================
  describe('3. Duplicate upload without creating duplicate records', () => {
    it('skips duplicate physical lines on repeated record insertion (idempotent)', async () => {
      const file = await sourceRepo.createSourceFile(orgA, {
        fileName: 'Idempotent_Stream.csv',
        fileFingerprint: 'idempotent_test_fingerprint_998877',
        fileSizeBytes: 5000n,
        storageUri: 's3://vault/idem.csv',
        sourceReportType: 'AMAZON_MTR'
      });

      const records = [
        {
          physicalLineNumber: 2,
          logicalRecordNumber: 1,
          recordType: RecordType.OUTWARD_SUPPLY,
          rawPayload: { orderId: 'ORD-101', amount: 1500.0 }
        },
        {
          physicalLineNumber: 3,
          logicalRecordNumber: 2,
          recordType: RecordType.OUTWARD_SUPPLY,
          rawPayload: { orderId: 'ORD-102', amount: 2500.0 }
        },
        {
          physicalLineNumber: 4,
          logicalRecordNumber: 3,
          recordType: RecordType.CREDIT_NOTE,
          rawPayload: { orderId: 'ORD-101', refundAmount: 500.0 }
        }
      ];

      // First insertion: all 3 inserted
      const res1 = await sourceRepo.bulkInsertSourceRecords(orgA, file.id, records);
      expect(res1.insertedCount).toBe(3);
      expect(res1.skippedCount).toBe(0);

      // Re-upload exact same records: all 3 skipped, 0 inserted
      const res2 = await sourceRepo.bulkInsertSourceRecords(orgA, file.id, records);
      expect(res2.insertedCount).toBe(0);
      expect(res2.skippedCount).toBe(3);

      // Total count in database remains exactly 3
      const count = await sourceRepo.countRecordsBySourceFile(orgA, file.id);
      expect(count).toBe(3);
    });
  });

  // ==========================================
  // REQUIREMENT 4: EXPLICIT REPROCESSING WITH NEW IMPORT BATCH
  // ==========================================
  describe('4. Explicit reprocessing with a new ImportBatch', () => {
    it('creates versioned reprocessing batch referencing existing source file and parent batch', async () => {
      const file = await sourceRepo.createSourceFile(orgA, {
        fileName: 'Reprocess_Test.csv',
        fileFingerprint: 'reprocess_batch_fp_445566',
        fileSizeBytes: 8000n,
        storageUri: 's3://vault/rep.csv',
        sourceReportType: 'AMAZON_MTR'
      });

      // 1. Initial Batch
      const batch1 = await batchRepo.createBatch(orgA, {
        batchNumber: 'BATCH-ORIGINAL-001',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1',
        sourceFileIds: [file.id]
      });

      await batchRepo.updateBatchStatus(
        orgA,
        batch1.id,
        BatchStatus.PENDING,
        BatchStatus.PROCESSING
      );
      await batchRepo.updateBatchStatus(
        orgA,
        batch1.id,
        BatchStatus.PROCESSING,
        BatchStatus.COMPLETED,
        { totalRecordsProcessed: 10 }
      );

      // 2. Reprocessing Batch with newer rules version
      const batch2 = await batchRepo.createReprocessingBatch(orgA, {
        newBatchNumber: 'BATCH-REPROCESS-002',
        parentBatchId: batch1.id,
        reprocessReason: 'Statutory Section 52 TCS rate reduction (Notification 15/2024)',
        engineVersion: '0.2.0',
        rulesVersion: '2024.2',
        sourceFileIds: [file.id]
      });

      expect(batch2.id).toBeDefined();
      expect(batch2.parentBatchId).toBe(batch1.id);
      expect(batch2.executionMode).toBe('REPROCESSING');
      expect(batch2.engineVersion).toBe('0.2.0');
      expect(batch2.rulesVersion).toBe('2024.2');
      expect(batch2.reprocessReason).toContain('Statutory Section 52');

      // Verify batch hierarchy
      const retrievedBatch2 = await batchRepo.getBatchById(orgA, batch2.id);
      expect(retrievedBatch2?.parentBatch?.id).toBe(batch1.id);
      expect(retrievedBatch2?.parentBatch?.status).toBe(BatchStatus.COMPLETED);
      expect(retrievedBatch2?.fileAssociations.length).toBe(1);
      expect(retrievedBatch2?.fileAssociations[0].sourceFileId).toBe(file.id);

      // Verify original batch remains immutable and unchanged
      const retrievedBatch1 = await batchRepo.getBatchById(orgA, batch1.id);
      expect(retrievedBatch1?.status).toBe(BatchStatus.COMPLETED);
      expect(retrievedBatch1?.rulesVersion).toBe('2024.1');
    });
  });

  // ==========================================
  // REQUIREMENT 5: REUSE OF EXISTING SOURCE RECORDS
  // ==========================================
  describe('5. Reuse of existing SourceRecords', () => {
    it('reuses existing source records during reprocessing with zero data duplication', async () => {
      const file = await sourceRepo.createSourceFile(orgA, {
        fileName: 'Reuse_Source_Records.csv',
        fileFingerprint: 'reuse_records_fp_778899',
        fileSizeBytes: 12000n,
        storageUri: 's3://vault/reuse.csv',
        sourceReportType: 'AMAZON_MTR'
      });

      await sourceRepo.bulkInsertSourceRecords(orgA, file.id, [
        {
          physicalLineNumber: 2,
          logicalRecordNumber: 1,
          recordType: RecordType.OUTWARD_SUPPLY,
          rawPayload: { sku: 'SKU-001', taxable: 1000 }
        },
        {
          physicalLineNumber: 3,
          logicalRecordNumber: 2,
          recordType: RecordType.OUTWARD_SUPPLY,
          rawPayload: { sku: 'SKU-002', taxable: 2000 }
        }
      ]);

      const recordsBefore = await sourceRepo.findRecordsBySourceFile(orgA, file.id);
      expect(recordsBefore.length).toBe(2);

      // During reprocessing, we query the exact same records
      const recordsForReprocess = await sourceRepo.findRecordsBySourceFile(orgA, file.id);
      expect(recordsForReprocess.length).toBe(2);
      expect(recordsForReprocess[0].id).toBe(recordsBefore[0].id);
      expect(recordsForReprocess[1].id).toBe(recordsBefore[1].id);
      expect(recordsForReprocess[0].rawPayload).toEqual({ sku: 'SKU-001', taxable: 1000 });

      // Count remains exactly 2 (zero duplicate records inserted)
      const totalCount = await sourceRepo.countRecordsBySourceFile(orgA, file.id);
      expect(totalCount).toBe(2);
    });
  });

  // ==========================================
  // REQUIREMENT 6: CROSS-TENANT READ/WRITE REJECTION
  // ==========================================
  describe('6. Cross-tenant read/write rejection', () => {
    it('strictly isolates tenant data across files, batches and records', async () => {
      // Ingest data in Tenant B
      const fileB = await sourceRepo.createSourceFile(orgB, {
        fileName: 'TenantB_Private.csv',
        fileFingerprint: 'tenant_b_isolated_fp_1122',
        fileSizeBytes: 3000n,
        storageUri: 's3://vault/b_priv.csv',
        sourceReportType: 'AMAZON_MTR'
      });

      const batchB = await batchRepo.createBatch(orgB, {
        batchNumber: 'BATCH-B-PRIVATE',
        engineVersion: '0.1.0',
        rulesVersion: '2026.1',
        sourceFileIds: [fileB.id]
      });

      await sourceRepo.bulkInsertSourceRecords(orgB, fileB.id, [
        {
          physicalLineNumber: 2,
          logicalRecordNumber: 1,
          recordType: RecordType.OUTWARD_SUPPLY,
          rawPayload: { secretTenantBData: true }
        }
      ]);

      // 1. Tenant A cannot read Tenant B's file
      expect(await sourceRepo.findSourceFileById(orgA, fileB.id)).toBeNull();
      expect(
        await sourceRepo.findSourceFileByFingerprint(orgA, 'tenant_b_isolated_fp_1122')
      ).toBeNull();

      // 2. Tenant A cannot read Tenant B's batch
      expect(await batchRepo.getBatchById(orgA, batchB.id)).toBeNull();
      expect(await batchRepo.getBatchByNumber(orgA, 'BATCH-B-PRIVATE')).toBeNull();

      // 3. Tenant A cannot associate Tenant B's file to Tenant A's batch
      const batchA = await batchRepo.createBatch(orgA, {
        batchNumber: 'BATCH-A-TRY-B',
        engineVersion: '0.1.0',
        rulesVersion: '2026.1'
      });
      await expect(
        batchRepo.associateSourceFile(orgA, batchA.id, fileB.id)
      ).rejects.toThrow(SourceFileNotFoundError);

      // 4. Tenant A cannot query Tenant B's records
      await expect(
        sourceRepo.findRecordsBySourceFile(orgA, fileB.id)
      ).rejects.toThrow(SourceFileNotFoundError);

      // 5. Database RLS blocks cross-tenant insertion even if bypassing repository checks
      await expect(
        runInTenantTransaction(prisma, orgA, async (tx) => {
          // Attempt direct insert of Tenant B org_id while SET LOCAL is orgA
          await tx.$executeRaw`
            INSERT INTO source_records (
              id, organization_id, source_file_id, physical_line_number,
              logical_record_number, record_type, raw_payload
            ) VALUES (
              gen_random_uuid(), ${orgB.organizationId}::uuid, ${fileB.id}::uuid,
              999, 999, 'OUTWARD_SUPPLY'::"RecordType", '{"hacked": true}'::jsonb
            );
          `;
        })
      ).rejects.toThrow();
    });
  });

  // ==========================================
  // REQUIREMENT 7: BULK INSERTION CORRECTNESS
  // ==========================================
  describe('7. Bulk insertion correctness', () => {
    it('correctly inserts 500 heterogeneous records with pagination and type filtering', async () => {
      const file = await sourceRepo.createSourceFile(orgA, {
        fileName: 'Bulk_500_Records.csv',
        fileFingerprint: 'bulk_500_records_fp_123456789',
        fileSizeBytes: 500000n,
        storageUri: 's3://vault/bulk500.csv',
        sourceReportType: 'AMAZON_MTR',
        totalPhysicalLines: 501
      });

      const recordsToInsert = [];
      const recordTypes = [
        RecordType.OUTWARD_SUPPLY,
        RecordType.CREDIT_NOTE,
        RecordType.STOCK_TRANSFER,
        RecordType.CANCELLED_ORDER,
        RecordType.MALFORMED
      ];

      for (let i = 1; i <= 500; i++) {
        const type = recordTypes[(i - 1) % recordTypes.length];
        recordsToInsert.push({
          physicalLineNumber: i + 1,
          logicalRecordNumber: i,
          recordType: type,
          rawPayload: {
            testRow: i,
            invoiceNumber: `INV-${1000 + i}`,
            taxable: i * 10,
            meta: { asin: `B00${i}`, category: 'Electronics' }
          }
        });
      }

      const res = await sourceRepo.bulkInsertSourceRecords(orgA, file.id, recordsToInsert);
      expect(res.insertedCount).toBe(500);
      expect(res.skippedCount).toBe(0);
      expect(res.totalProvided).toBe(500);

      // Verify total count
      const totalCount = await sourceRepo.countRecordsBySourceFile(orgA, file.id);
      expect(totalCount).toBe(500);

      // Verify filtered count: exactly 100 per type
      const outwardCount = await sourceRepo.countRecordsBySourceFile(
        orgA,
        file.id,
        RecordType.OUTWARD_SUPPLY
      );
      expect(outwardCount).toBe(100);

      const creditNoteCount = await sourceRepo.countRecordsBySourceFile(
        orgA,
        file.id,
        RecordType.CREDIT_NOTE
      );
      expect(creditNoteCount).toBe(100);

      // Verify pagination (limit 25, offset 50)
      const page = await sourceRepo.findRecordsBySourceFile(orgA, file.id, {
        limit: 25,
        offset: 50
      });
      expect(page.length).toBe(25);
      // physical line numbers should be strictly sequential
      expect(page[0].physicalLineNumber).toBe(52); // offset 50 -> 51st item (1-based index 51, phys line 52)
      expect(page[24].physicalLineNumber).toBe(76);
    });
  });

  // ==========================================
  // REQUIREMENT 8: TRANSACTION ROLLBACK BEHAVIOR
  // ==========================================
  describe('8. Transaction rollback behavior', () => {
    it('rolls back completely on error leaving zero orphaned data in PostgreSQL', async () => {
      const uniqueBatchNum = `ROLLBACK-TEST-${Date.now()}`;
      const uniqueFp = `rollback_test_fp_${Date.now()}`;

      await expect(
        runInTenantTransaction(prisma, orgA, async (tx) => {
          // 1. Create source file
          const file = await sourceRepo.createSourceFile(
            orgA,
            {
              fileName: 'Will_Rollback.csv',
              fileFingerprint: uniqueFp,
              fileSizeBytes: 1000n,
              storageUri: 's3://vault/rollback.csv',
              sourceReportType: 'AMAZON_MTR'
            },
            tx
          );

          // 2. Create batch
          await batchRepo.createBatch(
            orgA,
            {
              batchNumber: uniqueBatchNum,
              engineVersion: '1.0.0',
              rulesVersion: '2026.1',
              sourceFileIds: [file.id]
            },
            tx
          );

          // 3. Deliberately throw an unhandled exception before commit
          throw new Error('Simulated mid-pipeline unrecoverable crash!');
        })
      ).rejects.toThrow('Simulated mid-pipeline unrecoverable crash!');

      // Verify that neither the file nor the batch was committed
      const fileAfter = await sourceRepo.findSourceFileByFingerprint(orgA, uniqueFp);
      expect(fileAfter).toBeNull();

      const batchAfter = await batchRepo.getBatchByNumber(orgA, uniqueBatchNum);
      expect(batchAfter).toBeNull();
    });
  });

  // ==========================================
  // REQUIREMENT 9: CONCURRENT DUPLICATE INGESTION
  // ==========================================
  describe('9. Concurrent duplicate ingestion', () => {
    it('safely handles concurrent duplicate insertions without deadlock or duplicate lines', async () => {
      const file = await sourceRepo.createSourceFile(orgA, {
        fileName: 'Concurrent_Test.csv',
        fileFingerprint: `concurrent_fp_${Date.now()}`,
        fileSizeBytes: 20000n,
        storageUri: 's3://vault/concurrent.csv',
        sourceReportType: 'AMAZON_MTR'
      });

      const recordsBatch = Array.from({ length: 50 }, (_, i) => ({
        physicalLineNumber: i + 2,
        logicalRecordNumber: i + 1,
        recordType: RecordType.OUTWARD_SUPPLY,
        rawPayload: { concurrentOrderId: `ORD-CONCUR-${i}` }
      }));

      // Simulate 3 workers attempting to insert the exact same records simultaneously
      const results = await Promise.all([
        sourceRepo.bulkInsertSourceRecords(orgA, file.id, recordsBatch),
        sourceRepo.bulkInsertSourceRecords(orgA, file.id, recordsBatch),
        sourceRepo.bulkInsertSourceRecords(orgA, file.id, recordsBatch)
      ]);

      const totalInserted = results.reduce((acc, r) => acc + r.insertedCount, 0);
      expect(totalInserted).toBe(50); // Exactly 50 records inserted across all workers

      const dbCount = await sourceRepo.countRecordsBySourceFile(orgA, file.id);
      expect(dbCount).toBe(50); // Exact row count in PostgreSQL
    });
  });

  // ==========================================
  // REQUIREMENT 10: CONNECTION-POOL TENANT CONTEXT ISOLATION
  // ==========================================
  describe('10. Connection-pool tenant context isolation', () => {
    it('verifies SET LOCAL reverts completely upon COMMIT and prevents pool context leakage', async () => {
      // 1. Transaction under Tenant A
      await runInTenantTransaction(prisma, orgA, async (tx) => {
        const settingRes: any = await tx.$queryRaw`
          SELECT current_setting('app.current_organization_id', true) AS guc;
        `;
        expect(settingRes[0].guc).toBe(orgA.organizationId);
      });

      // 2. Direct raw query on a connection outside a transaction
      // SET LOCAL should have reverted to NULL upon transaction completion
      const rawRes: any = await prisma.$queryRaw`
        SELECT current_setting('app.current_organization_id', true) AS guc;
      `;
      expect(rawRes[0].guc).toBeFalsy(); // null or empty string

      // 3. Querying source_files without tenant context returns 0 rows due to RLS fail-closed
      const filesOutsideContext: any = await prisma.$queryRaw`
        SELECT count(*)::int AS count FROM source_files;
      `;
      expect(filesOutsideContext[0].count).toBe(0);
    });

    it('verifies SET LOCAL reverts completely upon ROLLBACK', async () => {
      try {
        await runInTenantTransaction(prisma, orgA, async (tx) => {
          throw new Error('Forced rollback to verify GUC reversion');
        });
      } catch {}

      const rawRes: any = await prisma.$queryRaw`
        SELECT current_setting('app.current_organization_id', true) AS guc;
      `;
      expect(rawRes[0].guc).toBeFalsy();
    });
  });
});
