import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { Decimal } from '../../src/utils/decimal.js';
import {
  PersistentPipelineOrchestrator
} from '../../src/application/persistent-pipeline/index.js';
import {
  PrismaImportBatchRepository,
  PrismaSourceRecordRepository,
  PrismaCanonicalDocumentRepository,
  PrismaProcessingResultRepository,
  PrismaReconciliationRepository,
  PrismaTransactionManager,
  TenantContext,
  BatchStatus,
  runInTenantTransaction,
  CanonicalCreditNoteAlreadyReconciledError
} from '../../src/repositories/index.js';

describe('Phase 3B.4.4: Persistent Credit Note Reconciliation & Ledger Integration — PostgreSQL 16 Suite', () => {
  let pgServer: any;
  let adminClient: pg.Client;
  let prisma: PrismaClient;

  let batchRepo: PrismaImportBatchRepository;
  let sourceRecordRepo: PrismaSourceRecordRepository;
  let canonicalRepo: PrismaCanonicalDocumentRepository;
  let processingResultRepo: PrismaProcessingResultRepository;
  let reconciliationRepo: PrismaReconciliationRepository;
  let txManager: PrismaTransactionManager;
  let orchestrator: PersistentPipelineOrchestrator;

  const testDbName = 'gstflow_phase3b44_test_db';
  const testPort = 54340;
  const dataDir = path.resolve('.pgdata_phase3b44');

  const orgA: TenantContext = { organizationId: crypto.randomUUID() };
  const orgB: TenantContext = { organizationId: crypto.randomUUID() };

  const syntheticB2BPath = path.resolve(
    __dirname,
    '../../GSTFlow_Synthetic_Test_Suite/amazon/synthetic_amazon_mtr_b2b.csv'
  );
  const syntheticCreditNotesPath = path.resolve(
    __dirname,
    '../../GSTFlow_Synthetic_Test_Suite/amazon/synthetic_amazon_credit_notes.csv'
  );

  const testUploadsDir = path.resolve('.test_temp_uploads_pg_domain_rec');

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
        ('${orgA.organizationId}', 'Domain Rec Org A', 'AAACA1234A', 72, NOW(), NOW()),
        ('${orgB.organizationId}', 'Domain Rec Org B', 'AAACB5678B', 72, NOW(), NOW());
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
    reconciliationRepo = new PrismaReconciliationRepository(prisma);
    txManager = new PrismaTransactionManager(prisma);

    orchestrator = new PersistentPipelineOrchestrator({
      importBatchRepo: batchRepo,
      sourceRecordRepo,
      canonicalDocRepo: canonicalRepo,
      processingResultRepo,
      reconciliationRepo,
      transactionManager: txManager,
      stagingChunkSize: 500,
      persistenceChunkSize: 100,
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
        fs.rmSync(testUploadsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
      if (fs.existsSync(dataDir)) {
        fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    } catch {}
  });

  // Target Invoice: AMZ/26-27/0000038 from B2B line 39
  // Target Credit Note: CN/26-27/000001 from CN line 2
  let batch1InvoiceResultId: string;

  it('1. Cross-Batch Reconciliation: Batch 1 processes invoice, Batch 2 processes matching credit note and updates cumulative reversals', async () => {
    // Prepare Batch 1 file: Header + Row 39 (AMZ/26-27/0000038)
    const b2bLines = fs.readFileSync(syntheticB2BPath, 'utf8').split('\n');
    const b2bHeader = b2bLines[0];
    const b2bRow = b2bLines[38]; // 0-based index 38 is row 39

    const batch1File = path.join(testUploadsDir, 'batch1_invoice.csv');
    fs.writeFileSync(batch1File, `${b2bHeader}\n${b2bRow}\n`, 'utf8');

    // Run Batch 1
    const run1 = await orchestrator.runBatch(orgA, {
      batchNumber: 'BATCH-REC-E2E-001',
      engineVersion: '0.1.0',
      rulesVersion: '2024.1',
      filePaths: [batch1File],
      stageSourceRecords: true,
      persistProcessingResults: true
    });

    expect(run1.success).toBe(true);
    expect(run1.persistenceResult?.invoicesPersisted).toBe(1);

    // Verify invoice result created with zero reversals
    await runInTenantTransaction(prisma, orgA, async (tx) => {
      const invCanonical = await tx.canonicalInvoice.findFirst({
        where: {
          organizationId: orgA.organizationId,
          invoiceNumber: 'AMZ/26-27/0000038'
        }
      });
      expect(invCanonical).not.toBeNull();

      const invResults = await tx.invoiceProcessingResult.findMany({
        where: {
          organizationId: orgA.organizationId,
          canonicalInvoiceId: invCanonical!.id
        }
      });
      expect(invResults.length).toBe(1);
      batch1InvoiceResultId = invResults[0].id;
      expect(new Decimal(invResults[0].cumulativeTaxableReversed.toString()).equals(new Decimal('0.00'))).toBe(true);
      expect(invResults[0].reversalCount).toBe(0);
    });

    // Prepare Batch 2 file: Header + Row 2 (CN/26-27/000001)
    const cnLines = fs.readFileSync(syntheticCreditNotesPath, 'utf8').split('\n');
    const cnHeader = cnLines[0];
    const cnRow = cnLines[1]; // Row 2

    const batch2File = path.join(testUploadsDir, 'batch2_credit_note.csv');
    fs.writeFileSync(batch2File, `${cnHeader}\n${cnRow}\n`, 'utf8');

    // Run Batch 2
    const run2 = await orchestrator.runBatch(orgA, {
      batchNumber: 'BATCH-REC-E2E-002',
      engineVersion: '0.1.0',
      rulesVersion: '2024.1',
      filePaths: [batch2File],
      stageSourceRecords: true,
      persistProcessingResults: true
    });

    expect(run2.success).toBe(true);
    expect(run2.persistenceResult?.creditNotesPersisted).toBe(1);
    expect(run2.persistenceResult?.reconciliationsCreated).toBe(1);
    expect(run2.persistenceResult?.cumulativeReversalsApplied).toBe(1);

    // Verify reconciliation and updated cumulative balance in PostgreSQL
    await runInTenantTransaction(prisma, orgA, async (tx) => {
      const rec = await tx.reconciliation.findFirst({
        where: {
          organizationId: orgA.organizationId,
          importBatchId: run2.batch.id
        }
      });
      expect(rec).not.toBeNull();
      expect(rec?.invoiceResultId).toBe(batch1InvoiceResultId);
      expect(new Decimal(rec!.taxableReversed.toString()).equals(new Decimal('16778.28'))).toBe(true);
      expect(new Decimal(rec!.totalReversed.toString()).equals(new Decimal('21476.20'))).toBe(true);

      // Verify Batch 1 invoice processing result updated atomically
      const updatedInv = await tx.invoiceProcessingResult.findUnique({
        where: { id: batch1InvoiceResultId }
      });
      expect(new Decimal(updatedInv!.cumulativeTaxableReversed.toString()).equals(new Decimal('16778.28'))).toBe(true);
      expect(new Decimal(updatedInv!.cumulativeTotalReversed.toString()).equals(new Decimal('21476.20'))).toBe(true);
      expect(updatedInv?.reversalCount).toBe(1);
    });
  });

  it('2. Double-Reconciliation Prevention: Rejects double application of same credit note in new STANDARD batch', async () => {
    const batch2File = path.join(testUploadsDir, 'batch2_credit_note.csv');

    // Attempt to process the same credit note file under Batch 3 in STANDARD mode
    await expect(
      orchestrator.runBatch(orgA, {
        batchNumber: 'BATCH-REC-DOUBLE-003',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1',
        filePaths: [batch2File],
        stageSourceRecords: true,
        persistProcessingResults: true
      })
    ).rejects.toThrow(CanonicalCreditNoteAlreadyReconciledError);

    // Verify invoice cumulative reversal was NOT altered
    await runInTenantTransaction(prisma, orgA, async (tx) => {
      const inv = await tx.invoiceProcessingResult.findUnique({
        where: { id: batch1InvoiceResultId }
      });
      expect(new Decimal(inv!.cumulativeTaxableReversed.toString()).equals(new Decimal('16778.28'))).toBe(true);
      expect(inv?.reversalCount).toBe(1);
    });
  });

  it('3. Reprocessing Supersession: Reprocessing batch supersedes prior reconciliation without duplicating financial balance', async () => {
    const batch2File = path.join(testUploadsDir, 'batch2_credit_note.csv');

    // Run Batch 4 with executionMode: 'REPROCESSING'
    const run4 = await orchestrator.runBatch(orgA, {
      batchNumber: 'BATCH-REC-REPROCESS-004',
      engineVersion: '0.2.0',
      rulesVersion: '2025.1',
      executionMode: 'REPROCESSING',
      reprocessReason: 'Statutory update',
      filePaths: [batch2File],
      stageSourceRecords: true,
      persistProcessingResults: true
    });

    expect(run4.success).toBe(true);
    expect(run4.persistenceResult?.creditNotesPersisted).toBe(1);
    expect(run4.persistenceResult?.reconciliationsCreated).toBe(0);
    expect(run4.persistenceResult?.reconciliationsSuperseded).toBe(1);
    expect(run4.persistenceResult?.cumulativeReversalsApplied).toBe(0);

    // Verify invoice cumulative reversal balance was NOT doubled
    await runInTenantTransaction(prisma, orgA, async (tx) => {
      const inv = await tx.invoiceProcessingResult.findUnique({
        where: { id: batch1InvoiceResultId }
      });
      expect(new Decimal(inv!.cumulativeTaxableReversed.toString()).equals(new Decimal('16778.28'))).toBe(true);
      expect(inv?.reversalCount).toBe(1);
    });
  });

  it('4. Multi-Tenant RLS: Org B cannot view Org A reconciliations or reverse against Org A invoices', async () => {
    await runInTenantTransaction(prisma, orgB, async (tx) => {
      const recsForOrgB = await tx.reconciliation.count({
        where: { organizationId: orgB.organizationId }
      });
      expect(recsForOrgB).toBe(0);
    });
  });
});
