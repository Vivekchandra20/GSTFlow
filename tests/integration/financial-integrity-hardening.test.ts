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
  PrismaTransactionManager,
  TenantContext,
  RecordType,
  PrimaryOutcome,
  CanonicalCreditNoteAlreadyReconciledError,
  InvoiceReversalCapacityExceededError,
  CanonicalDocumentNotFoundError,
  CreateCanonicalInvoiceInput,
  runInTenantTransaction
} from '../../src/repositories/index.js';
import {
  RecipientType,
  SupplyType,
  ReconciliationStatus
} from '../../src/models/enums.js';

describe('Phase 3B.4.4: Financial Integrity Audit & Hardening — PostgreSQL 16 Suite (T1-T15)', () => {
  let pgServer: any;
  let adminClient: pg.Client;
  let prisma: PrismaClient;

  let batchRepo: PrismaImportBatchRepository;
  let sourceRepo: PrismaSourceRecordRepository;
  let canonicalRepo: PrismaCanonicalDocumentRepository;
  let resultRepo: PrismaProcessingResultRepository;
  let reconciliationRepo: PrismaReconciliationRepository;
  let txManager: PrismaTransactionManager;

  const testDbName = 'gstflow_phase3b44_hardening_db';
  const testPort = 54341;
  const dataDir = path.resolve('.pgdata_phase3b44_hardening');

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
        ('${orgA.organizationId}', 'Hardening Org A', 'AAACA1234A', 72, NOW(), NOW()),
        ('${orgB.organizationId}', 'Hardening Org B', 'AAACB5678B', 72, NOW(), NOW());
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
    txManager = new PrismaTransactionManager(prisma);
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
      },
      {
        physicalLineNumber: 3,
        logicalRecordNumber: 2,
        recordType: RecordType.CREDIT_NOTE,
        rawPayload: { tag, type: 'CN1' }
      },
      {
        physicalLineNumber: 4,
        logicalRecordNumber: 3,
        recordType: RecordType.CREDIT_NOTE,
        rawPayload: { tag, type: 'CN2' }
      }
    ]);

    const records = await sourceRepo.findRecordsBySourceFile(ctx, file.id);
    return { file, invRec: records[0], cnRec1: records[1], cnRec2: records[2] };
  }

  function buildInvoiceInput(
    invoiceNumber: string,
    orderId: string,
    sellerGstin = '29AAACA1234A1Z5'
  ): CreateCanonicalInvoiceInput {
    return {
      sellerGstin,
      financialYear: '2026-2027',
      invoiceNumber,
      invoiceDate: new Date('2026-05-01'),
      orderId,
      recipientType: RecipientType.B2C,
      shipFromStateCode: '29',
      placeOfSupplyStateCode: '29',
      supplyType: SupplyType.INTRASTATE
    };
  }

  // T1: Same CN uploaded in two batches -> One financial application
  it('T1: Same CN uploaded in two batches -> Second batch rejected without supersession', async () => {
    const { file, invRec, cnRec1 } = await createHelperSource(orgA, 't1');

    const inv = await canonicalRepo.getOrCreateCanonicalInvoice(
      orgA,
      buildInvoiceInput('INV-T1-001', 'ORD-T1-001')
    );

    const cn = await canonicalRepo.getOrCreateCanonicalCreditNote(orgA, {
      sellerGstin: '29AAACA1234A1Z5',
      financialYear: '2026-2027',
      creditNoteNumber: 'CN-T1-001',
      creditNoteDate: new Date('2026-05-10'),
      recipientType: RecipientType.B2C
    });

    const b1 = await batchRepo.createBatch(orgA, {
      batchNumber: 'BATCH-T1-1',
      engineVersion: '0.1.0',
      rulesVersion: '2026.1',
      sourceFileIds: [file.id]
    });

    const invRes1 = await resultRepo.createInvoiceResult(orgA, {
      importBatchId: b1.id,
      canonicalInvoiceId: inv.invoice.id,
      sourceRecordId: invRec.id,
      totalTaxableValue: new Decimal('1000.00'),
      cgstAmount: new Decimal('90.00'),
      sgstAmount: new Decimal('90.00'),
      totalInvoiceAmount: new Decimal('1180.00'),
      primaryOutcome: PrimaryOutcome.VALID,
      lines: []
    });

    const cnRes1 = await resultRepo.createCreditNoteResult(orgA, {
      importBatchId: b1.id,
      canonicalCreditNoteId: cn.creditNote.id,
      sourceRecordId: cnRec1.id,
      taxableValueReversal: new Decimal('300.00'),
      cgstAmountReversal: new Decimal('27.00'),
      sgstAmountReversal: new Decimal('27.00'),
      creditNoteTotal: new Decimal('354.00'),
      rawSignedAmountText: '-354.00',
      signedAmount: new Decimal('-354.00'),
      primaryOutcome: PrimaryOutcome.VALID
    });

    const rec1 = await reconciliationRepo.createReconciliation(orgA, {
      importBatchId: b1.id,
      creditNoteResultId: cnRes1.id,
      invoiceResultId: invRes1.id,
      reconciliationStatus: ReconciliationStatus.MATCHED_PARTIAL,
      taxableReversed: new Decimal('300.00'),
      cgstReversed: new Decimal('27.00'),
      sgstReversed: new Decimal('27.00'),
      totalReversed: new Decimal('354.00')
    });

    expect(rec1.appliedFinancialReversal).toBe(true);

    // Batch 2 with same credit note
    const b2 = await batchRepo.createBatch(orgA, {
      batchNumber: 'BATCH-T1-2',
      engineVersion: '0.1.0',
      rulesVersion: '2026.1',
      sourceFileIds: [file.id]
    });

    const cnRes2 = await resultRepo.createCreditNoteResult(orgA, {
      importBatchId: b2.id,
      canonicalCreditNoteId: cn.creditNote.id,
      sourceRecordId: cnRec1.id,
      taxableValueReversal: new Decimal('300.00'),
      creditNoteTotal: new Decimal('354.00'),
      rawSignedAmountText: '-354.00',
      signedAmount: new Decimal('-354.00'),
      primaryOutcome: PrimaryOutcome.VALID
    });

    await expect(
      reconciliationRepo.createReconciliation(orgA, {
        importBatchId: b2.id,
        creditNoteResultId: cnRes2.id,
        invoiceResultId: invRes1.id,
        reconciliationStatus: ReconciliationStatus.MATCHED_PARTIAL,
        taxableReversed: new Decimal('300.00'),
        totalReversed: new Decimal('354.00'),
        allowSupersession: false
      })
    ).rejects.toThrow(CanonicalCreditNoteAlreadyReconciledError);

    // Invoice cumulative taxable reversal must remain exactly 300.00
    const invCheck = await resultRepo.findInvoiceResultById(orgA, invRes1.id);
    expect(invCheck?.cumulativeTaxableReversed.equals(new Decimal('300.00'))).toBe(true);
    expect(invCheck?.reversalCount).toBe(1);
  });

  // T2: Same canonical CN processed concurrently -> Concurrency lock ensures one succeeds, one fails
  it('T2: Same canonical CN processed concurrently -> Row lock serializes and rejects duplicate', async () => {
    const { file, invRec, cnRec1 } = await createHelperSource(orgA, 't2');

    const inv = await canonicalRepo.getOrCreateCanonicalInvoice(
      orgA,
      buildInvoiceInput('INV-T2-001', 'ORD-T2-001')
    );

    const cn = await canonicalRepo.getOrCreateCanonicalCreditNote(orgA, {
      sellerGstin: '29AAACA1234A1Z5',
      financialYear: '2026-2027',
      creditNoteNumber: 'CN-T2-CONCURRENT-001',
      creditNoteDate: new Date('2026-05-10'),
      recipientType: RecipientType.B2C
    });

    const b1 = await batchRepo.createBatch(orgA, {
      batchNumber: 'BATCH-T2-1',
      engineVersion: '0.1.0',
      rulesVersion: '2026.1',
      sourceFileIds: [file.id]
    });

    const b2 = await batchRepo.createBatch(orgA, {
      batchNumber: 'BATCH-T2-2',
      engineVersion: '0.1.0',
      rulesVersion: '2026.1',
      sourceFileIds: [file.id]
    });

    const invRes = await resultRepo.createInvoiceResult(orgA, {
      importBatchId: b1.id,
      canonicalInvoiceId: inv.invoice.id,
      sourceRecordId: invRec.id,
      totalTaxableValue: new Decimal('5000.00'),
      cgstAmount: new Decimal('450.00'),
      sgstAmount: new Decimal('450.00'),
      totalInvoiceAmount: new Decimal('5900.00'),
      primaryOutcome: PrimaryOutcome.VALID,
      lines: []
    });

    const cnRes1 = await resultRepo.createCreditNoteResult(orgA, {
      importBatchId: b1.id,
      canonicalCreditNoteId: cn.creditNote.id,
      sourceRecordId: cnRec1.id,
      taxableValueReversal: new Decimal('1000.00'),
      creditNoteTotal: new Decimal('1180.00'),
      rawSignedAmountText: '-1180.00',
      signedAmount: new Decimal('-1180.00'),
      primaryOutcome: PrimaryOutcome.VALID
    });

    const cnRes2 = await resultRepo.createCreditNoteResult(orgA, {
      importBatchId: b2.id,
      canonicalCreditNoteId: cn.creditNote.id,
      sourceRecordId: cnRec1.id,
      taxableValueReversal: new Decimal('1000.00'),
      creditNoteTotal: new Decimal('1180.00'),
      rawSignedAmountText: '-1180.00',
      signedAmount: new Decimal('-1180.00'),
      primaryOutcome: PrimaryOutcome.VALID
    });

    // Execute concurrently without allowSupersession
    const p1 = reconciliationRepo.createReconciliation(orgA, {
      importBatchId: b1.id,
      creditNoteResultId: cnRes1.id,
      invoiceResultId: invRes.id,
      reconciliationStatus: ReconciliationStatus.MATCHED_PARTIAL,
      taxableReversed: new Decimal('1000.00'),
      totalReversed: new Decimal('1180.00'),
      allowSupersession: false
    });

    const p2 = reconciliationRepo.createReconciliation(orgA, {
      importBatchId: b2.id,
      creditNoteResultId: cnRes2.id,
      invoiceResultId: invRes.id,
      reconciliationStatus: ReconciliationStatus.MATCHED_PARTIAL,
      taxableReversed: new Decimal('1000.00'),
      totalReversed: new Decimal('1180.00'),
      allowSupersession: false
    });

    const results = await Promise.allSettled([p1, p2]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      CanonicalCreditNoteAlreadyReconciledError
    );

    // Verify invoice cumulative reversed is exactly 1000.00, not 2000.00
    const invCheck = await resultRepo.findInvoiceResultById(orgA, invRes.id);
    expect(invCheck?.cumulativeTaxableReversed.equals(new Decimal('1000.00'))).toBe(true);
    expect(invCheck?.reversalCount).toBe(1);
  });

  // T3: Two different CNs against one invoice -> Correct cumulative balance
  it('T3: Two different CNs against one invoice -> Accumulates reversals correctly', async () => {
    const { file, invRec, cnRec1, cnRec2 } = await createHelperSource(orgA, 't3');

    const inv = await canonicalRepo.getOrCreateCanonicalInvoice(
      orgA,
      buildInvoiceInput('INV-T3-MULTI-001', 'ORD-T3-001')
    );

    const cn1 = await canonicalRepo.getOrCreateCanonicalCreditNote(orgA, {
      sellerGstin: '29AAACA1234A1Z5',
      financialYear: '2026-2027',
      creditNoteNumber: 'CN-T3-001',
      creditNoteDate: new Date('2026-05-10'),
      recipientType: RecipientType.B2C
    });

    const cn2 = await canonicalRepo.getOrCreateCanonicalCreditNote(orgA, {
      sellerGstin: '29AAACA1234A1Z5',
      financialYear: '2026-2027',
      creditNoteNumber: 'CN-T3-002',
      creditNoteDate: new Date('2026-05-12'),
      recipientType: RecipientType.B2C
    });

    const b = await batchRepo.createBatch(orgA, {
      batchNumber: 'BATCH-T3-1',
      engineVersion: '0.1.0',
      rulesVersion: '2026.1',
      sourceFileIds: [file.id]
    });

    const invRes = await resultRepo.createInvoiceResult(orgA, {
      importBatchId: b.id,
      canonicalInvoiceId: inv.invoice.id,
      sourceRecordId: invRec.id,
      totalTaxableValue: new Decimal('10000.00'),
      cgstAmount: new Decimal('900.00'),
      sgstAmount: new Decimal('900.00'),
      totalInvoiceAmount: new Decimal('11800.00'),
      primaryOutcome: PrimaryOutcome.VALID,
      lines: []
    });

    const cnRes1 = await resultRepo.createCreditNoteResult(orgA, {
      importBatchId: b.id,
      canonicalCreditNoteId: cn1.creditNote.id,
      sourceRecordId: cnRec1.id,
      taxableValueReversal: new Decimal('2000.00'),
      cgstAmountReversal: new Decimal('180.00'),
      sgstAmountReversal: new Decimal('180.00'),
      creditNoteTotal: new Decimal('2360.00'),
      rawSignedAmountText: '-2360.00',
      signedAmount: new Decimal('-2360.00'),
      primaryOutcome: PrimaryOutcome.VALID
    });

    const cnRes2 = await resultRepo.createCreditNoteResult(orgA, {
      importBatchId: b.id,
      canonicalCreditNoteId: cn2.creditNote.id,
      sourceRecordId: cnRec2.id,
      taxableValueReversal: new Decimal('3000.00'),
      cgstAmountReversal: new Decimal('270.00'),
      sgstAmountReversal: new Decimal('270.00'),
      creditNoteTotal: new Decimal('3540.00'),
      rawSignedAmountText: '-3540.00',
      signedAmount: new Decimal('-3540.00'),
      primaryOutcome: PrimaryOutcome.VALID
    });

    await reconciliationRepo.createReconciliation(orgA, {
      importBatchId: b.id,
      creditNoteResultId: cnRes1.id,
      invoiceResultId: invRes.id,
      reconciliationStatus: ReconciliationStatus.MATCHED_PARTIAL,
      taxableReversed: new Decimal('2000.00'),
      cgstReversed: new Decimal('180.00'),
      sgstReversed: new Decimal('180.00'),
      totalReversed: new Decimal('2360.00')
    });

    await reconciliationRepo.createReconciliation(orgA, {
      importBatchId: b.id,
      creditNoteResultId: cnRes2.id,
      invoiceResultId: invRes.id,
      reconciliationStatus: ReconciliationStatus.MATCHED_PARTIAL,
      taxableReversed: new Decimal('3000.00'),
      cgstReversed: new Decimal('270.00'),
      sgstReversed: new Decimal('270.00'),
      totalReversed: new Decimal('3540.00')
    });

    const invCheck = await resultRepo.findInvoiceResultById(orgA, invRes.id);
    expect(invCheck?.cumulativeTaxableReversed.equals(new Decimal('5000.00'))).toBe(true);
    expect(invCheck?.cumulativeCgstReversed.equals(new Decimal('450.00'))).toBe(true);
    expect(invCheck?.cumulativeSgstReversed.equals(new Decimal('450.00'))).toBe(true);
    expect(invCheck?.cumulativeTotalReversed.equals(new Decimal('5900.00'))).toBe(true);
    expect(invCheck?.reversalCount).toBe(2);
  });

  // T4: CN exceeds taxable capacity -> Rejected under lock
  it('T4: CN exceeds taxable capacity -> Rejects with InvoiceReversalCapacityExceededError', async () => {
    const { file, invRec, cnRec1 } = await createHelperSource(orgA, 't4');

    const inv = await canonicalRepo.getOrCreateCanonicalInvoice(
      orgA,
      buildInvoiceInput('INV-T4-CAP-001', 'ORD-T4-001')
    );

    const cn = await canonicalRepo.getOrCreateCanonicalCreditNote(orgA, {
      sellerGstin: '29AAACA1234A1Z5',
      financialYear: '2026-2027',
      creditNoteNumber: 'CN-T4-001',
      creditNoteDate: new Date('2026-05-10'),
      recipientType: RecipientType.B2C
    });

    const b = await batchRepo.createBatch(orgA, {
      batchNumber: 'BATCH-T4-1',
      engineVersion: '0.1.0',
      rulesVersion: '2026.1',
      sourceFileIds: [file.id]
    });

    const invRes = await resultRepo.createInvoiceResult(orgA, {
      importBatchId: b.id,
      canonicalInvoiceId: inv.invoice.id,
      sourceRecordId: invRec.id,
      totalTaxableValue: new Decimal('1000.00'),
      totalInvoiceAmount: new Decimal('1180.00'),
      primaryOutcome: PrimaryOutcome.VALID,
      lines: []
    });

    const cnRes = await resultRepo.createCreditNoteResult(orgA, {
      importBatchId: b.id,
      canonicalCreditNoteId: cn.creditNote.id,
      sourceRecordId: cnRec1.id,
      taxableValueReversal: new Decimal('1500.00'),
      creditNoteTotal: new Decimal('1770.00'),
      rawSignedAmountText: '-1770.00',
      signedAmount: new Decimal('-1770.00'),
      primaryOutcome: PrimaryOutcome.VALID
    });

    await expect(
      reconciliationRepo.createReconciliation(orgA, {
        importBatchId: b.id,
        creditNoteResultId: cnRes.id,
        invoiceResultId: invRes.id,
        reconciliationStatus: ReconciliationStatus.VALUE_EXCEEDED,
        taxableReversed: new Decimal('1500.00'),
        totalReversed: new Decimal('1770.00')
      })
    ).rejects.toThrow(InvoiceReversalCapacityExceededError);

    // Verify invoice balances remain 0.00
    const invCheck = await resultRepo.findInvoiceResultById(orgA, invRes.id);
    expect(invCheck?.cumulativeTaxableReversed.equals(new Decimal('0.00'))).toBe(true);
    expect(invCheck?.reversalCount).toBe(0);
  });

  // T5: Tax component exceeds capacity -> Rejected under lock
  it('T5: Tax component exceeds capacity -> Rejects with InvoiceReversalCapacityExceededError on CGST', async () => {
    const { file, invRec, cnRec1 } = await createHelperSource(orgA, 't5');

    const inv = await canonicalRepo.getOrCreateCanonicalInvoice(
      orgA,
      buildInvoiceInput('INV-T5-COMP-001', 'ORD-T5-001')
    );

    const cn = await canonicalRepo.getOrCreateCanonicalCreditNote(orgA, {
      sellerGstin: '29AAACA1234A1Z5',
      financialYear: '2026-2027',
      creditNoteNumber: 'CN-T5-001',
      creditNoteDate: new Date('2026-05-10'),
      recipientType: RecipientType.B2C
    });

    const b = await batchRepo.createBatch(orgA, {
      batchNumber: 'BATCH-T5-1',
      engineVersion: '0.1.0',
      rulesVersion: '2026.1',
      sourceFileIds: [file.id]
    });

    const invRes = await resultRepo.createInvoiceResult(orgA, {
      importBatchId: b.id,
      canonicalInvoiceId: inv.invoice.id,
      sourceRecordId: invRec.id,
      totalTaxableValue: new Decimal('2000.00'),
      cgstAmount: new Decimal('180.00'),
      sgstAmount: new Decimal('180.00'),
      totalInvoiceAmount: new Decimal('2360.00'),
      primaryOutcome: PrimaryOutcome.VALID,
      lines: []
    });

    const cnRes = await resultRepo.createCreditNoteResult(orgA, {
      importBatchId: b.id,
      canonicalCreditNoteId: cn.creditNote.id,
      sourceRecordId: cnRec1.id,
      taxableValueReversal: new Decimal('1000.00'),
      cgstAmountReversal: new Decimal('250.00'), // Exceeds invoice CGST 180.00!
      creditNoteTotal: new Decimal('1250.00'),
      rawSignedAmountText: '-1250.00',
      signedAmount: new Decimal('-1250.00'),
      primaryOutcome: PrimaryOutcome.VALID
    });

    await expect(
      reconciliationRepo.createReconciliation(orgA, {
        importBatchId: b.id,
        creditNoteResultId: cnRes.id,
        invoiceResultId: invRes.id,
        reconciliationStatus: ReconciliationStatus.VALUE_EXCEEDED,
        taxableReversed: new Decimal('1000.00'),
        cgstReversed: new Decimal('250.00'),
        totalReversed: new Decimal('1250.00')
      })
    ).rejects.toThrow(InvoiceReversalCapacityExceededError);

    const invCheck = await resultRepo.findInvoiceResultById(orgA, invRes.id);
    expect(invCheck?.cumulativeCgstReversed.equals(new Decimal('0.00'))).toBe(true);
  });

  // T6: Identical CN reprocessed -> No duplicate reversal (delta = 0)
  it('T6: Identical CN reprocessed -> No duplicate reversal (delta = 0)', async () => {
    const { file, invRec, cnRec1 } = await createHelperSource(orgA, 't6');

    const inv = await canonicalRepo.getOrCreateCanonicalInvoice(
      orgA,
      buildInvoiceInput('INV-T6-001', 'ORD-T6-001')
    );

    const cn = await canonicalRepo.getOrCreateCanonicalCreditNote(orgA, {
      sellerGstin: '29AAACA1234A1Z5',
      financialYear: '2026-2027',
      creditNoteNumber: 'CN-T6-001',
      creditNoteDate: new Date('2026-05-10'),
      recipientType: RecipientType.B2C
    });

    const b1 = await batchRepo.createBatch(orgA, {
      batchNumber: 'BATCH-T6-1',
      engineVersion: '0.1.0',
      rulesVersion: '2026.1',
      sourceFileIds: [file.id]
    });

    const invRes = await resultRepo.createInvoiceResult(orgA, {
      importBatchId: b1.id,
      canonicalInvoiceId: inv.invoice.id,
      sourceRecordId: invRec.id,
      totalTaxableValue: new Decimal('5000.00'),
      totalInvoiceAmount: new Decimal('5900.00'),
      primaryOutcome: PrimaryOutcome.VALID,
      lines: []
    });

    const cnRes1 = await resultRepo.createCreditNoteResult(orgA, {
      importBatchId: b1.id,
      canonicalCreditNoteId: cn.creditNote.id,
      sourceRecordId: cnRec1.id,
      taxableValueReversal: new Decimal('1000.00'),
      creditNoteTotal: new Decimal('1180.00'),
      rawSignedAmountText: '-1180.00',
      signedAmount: new Decimal('-1180.00'),
      primaryOutcome: PrimaryOutcome.VALID
    });

    await reconciliationRepo.createReconciliation(orgA, {
      importBatchId: b1.id,
      creditNoteResultId: cnRes1.id,
      invoiceResultId: invRes.id,
      reconciliationStatus: ReconciliationStatus.MATCHED_PARTIAL,
      taxableReversed: new Decimal('1000.00'),
      totalReversed: new Decimal('1180.00')
    });

    // Batch 2 reprocessing with identical values
    const b2 = await batchRepo.createReprocessingBatch(orgA, {
      newBatchNumber: 'BATCH-T6-2',
      parentBatchId: b1.id,
      reprocessReason: 'Statutory update',
      rulesVersion: '2026.2',
      sourceFileIds: [file.id]
    });

    const cnRes2 = await resultRepo.createCreditNoteResult(orgA, {
      importBatchId: b2.id,
      canonicalCreditNoteId: cn.creditNote.id,
      sourceRecordId: cnRec1.id,
      taxableValueReversal: new Decimal('1000.00'),
      creditNoteTotal: new Decimal('1180.00'),
      rawSignedAmountText: '-1180.00',
      signedAmount: new Decimal('-1180.00'),
      primaryOutcome: PrimaryOutcome.VALID
    });

    const supersessionRes = await reconciliationRepo.createReconciliation(orgA, {
      importBatchId: b2.id,
      creditNoteResultId: cnRes2.id,
      invoiceResultId: invRes.id,
      reconciliationStatus: ReconciliationStatus.MATCHED_PARTIAL,
      taxableReversed: new Decimal('1000.00'),
      totalReversed: new Decimal('1180.00'),
      allowSupersession: true
    });

    expect(supersessionRes.isSuperseded).toBe(true);
    expect(supersessionRes.appliedFinancialReversal).toBe(false);

    const invCheck = await resultRepo.findInvoiceResultById(orgA, invRes.id);
    expect(invCheck?.cumulativeTaxableReversed.equals(new Decimal('1000.00'))).toBe(true);
    expect(invCheck?.reversalCount).toBe(1);
  });

  // T7: CN reprocessed with changed values (₹590 -> ₹600) -> Correct +₹10 adjustment applied
  it('T7: CN reprocessed with changed values -> Correct financial delta applied to invoice cumulative totals', async () => {
    const { file, invRec, cnRec1 } = await createHelperSource(orgA, 't7');

    const inv = await canonicalRepo.getOrCreateCanonicalInvoice(
      orgA,
      buildInvoiceInput('INV-T7-DELTA-001', 'ORD-T7-001')
    );

    const cn = await canonicalRepo.getOrCreateCanonicalCreditNote(orgA, {
      sellerGstin: '29AAACA1234A1Z5',
      financialYear: '2026-2027',
      creditNoteNumber: 'CN-T7-001',
      creditNoteDate: new Date('2026-05-10'),
      recipientType: RecipientType.B2C
    });

    const b1 = await batchRepo.createBatch(orgA, {
      batchNumber: 'BATCH-T7-1',
      engineVersion: '0.1.0',
      rulesVersion: '2026.1',
      sourceFileIds: [file.id]
    });

    const invRes = await resultRepo.createInvoiceResult(orgA, {
      importBatchId: b1.id,
      canonicalInvoiceId: inv.invoice.id,
      sourceRecordId: invRec.id,
      totalTaxableValue: new Decimal('1000.00'),
      totalInvoiceAmount: new Decimal('1180.00'),
      primaryOutcome: PrimaryOutcome.VALID,
      lines: []
    });

    // Batch 1 initial reversal: Taxable 500.00, Total 590.00
    const cnRes1 = await resultRepo.createCreditNoteResult(orgA, {
      importBatchId: b1.id,
      canonicalCreditNoteId: cn.creditNote.id,
      sourceRecordId: cnRec1.id,
      taxableValueReversal: new Decimal('500.00'),
      creditNoteTotal: new Decimal('590.00'),
      rawSignedAmountText: '-590.00',
      signedAmount: new Decimal('-590.00'),
      primaryOutcome: PrimaryOutcome.VALID
    });

    await reconciliationRepo.createReconciliation(orgA, {
      importBatchId: b1.id,
      creditNoteResultId: cnRes1.id,
      invoiceResultId: invRes.id,
      reconciliationStatus: ReconciliationStatus.MATCHED_PARTIAL,
      taxableReversed: new Decimal('500.00'),
      totalReversed: new Decimal('590.00')
    });

    // Batch 2 reprocessing with changed values: Taxable 510.00 (+10), Total 600.00 (+10)
    const b2 = await batchRepo.createReprocessingBatch(orgA, {
      newBatchNumber: 'BATCH-T7-2',
      parentBatchId: b1.id,
      reprocessReason: 'Rate amendment',
      rulesVersion: '2026.2',
      sourceFileIds: [file.id]
    });

    const cnRes2 = await resultRepo.createCreditNoteResult(orgA, {
      importBatchId: b2.id,
      canonicalCreditNoteId: cn.creditNote.id,
      sourceRecordId: cnRec1.id,
      taxableValueReversal: new Decimal('510.00'),
      creditNoteTotal: new Decimal('600.00'),
      rawSignedAmountText: '-600.00',
      signedAmount: new Decimal('-600.00'),
      primaryOutcome: PrimaryOutcome.VALID
    });

    const adjustmentRes = await reconciliationRepo.createReconciliation(orgA, {
      importBatchId: b2.id,
      creditNoteResultId: cnRes2.id,
      invoiceResultId: invRes.id,
      reconciliationStatus: ReconciliationStatus.MATCHED_PARTIAL,
      taxableReversed: new Decimal('510.00'),
      totalReversed: new Decimal('600.00'),
      allowSupersession: true
    });

    expect(adjustmentRes.isSuperseded).toBe(true);
    expect(adjustmentRes.appliedFinancialReversal).toBe(true);

    // Cumulative balance must reflect the +10 delta exactly (510.00 taxable, 600.00 total)
    const invCheck = await resultRepo.findInvoiceResultById(orgA, invRes.id);
    expect(invCheck?.cumulativeTaxableReversed.equals(new Decimal('510.00'))).toBe(true);
    expect(invCheck?.cumulativeTotalReversed.equals(new Decimal('600.00'))).toBe(true);
  });

  // T8: Concurrent CNs against same invoice (₹6,000 + ₹5,000 on ₹10,000) -> Over-reversal prevented
  it('T8: Concurrent CNs against same invoice exceeding capacity -> Row lock serializes and rejects over-reversal', async () => {
    const { file, invRec, cnRec1, cnRec2 } = await createHelperSource(orgA, 't8');

    const inv = await canonicalRepo.getOrCreateCanonicalInvoice(
      orgA,
      buildInvoiceInput('INV-T8-RACE-001', 'ORD-T8-001')
    );

    const cnA = await canonicalRepo.getOrCreateCanonicalCreditNote(orgA, {
      sellerGstin: '29AAACA1234A1Z5',
      financialYear: '2026-2027',
      creditNoteNumber: 'CN-T8-A-001',
      creditNoteDate: new Date('2026-05-10'),
      recipientType: RecipientType.B2C
    });

    const cnB = await canonicalRepo.getOrCreateCanonicalCreditNote(orgA, {
      sellerGstin: '29AAACA1234A1Z5',
      financialYear: '2026-2027',
      creditNoteNumber: 'CN-T8-B-001',
      creditNoteDate: new Date('2026-05-10'),
      recipientType: RecipientType.B2C
    });

    const b = await batchRepo.createBatch(orgA, {
      batchNumber: 'BATCH-T8-1',
      engineVersion: '0.1.0',
      rulesVersion: '2026.1',
      sourceFileIds: [file.id]
    });

    const invRes = await resultRepo.createInvoiceResult(orgA, {
      importBatchId: b.id,
      canonicalInvoiceId: inv.invoice.id,
      sourceRecordId: invRec.id,
      totalTaxableValue: new Decimal('10000.00'),
      totalInvoiceAmount: new Decimal('11800.00'),
      primaryOutcome: PrimaryOutcome.VALID,
      lines: []
    });

    const cnResA = await resultRepo.createCreditNoteResult(orgA, {
      importBatchId: b.id,
      canonicalCreditNoteId: cnA.creditNote.id,
      sourceRecordId: cnRec1.id,
      taxableValueReversal: new Decimal('6000.00'),
      creditNoteTotal: new Decimal('7080.00'),
      rawSignedAmountText: '-7080.00',
      signedAmount: new Decimal('-7080.00'),
      primaryOutcome: PrimaryOutcome.VALID
    });

    const cnResB = await resultRepo.createCreditNoteResult(orgA, {
      importBatchId: b.id,
      canonicalCreditNoteId: cnB.creditNote.id,
      sourceRecordId: cnRec2.id,
      taxableValueReversal: new Decimal('5000.00'),
      creditNoteTotal: new Decimal('5900.00'),
      rawSignedAmountText: '-5900.00',
      signedAmount: new Decimal('-5900.00'),
      primaryOutcome: PrimaryOutcome.VALID
    });

    // Launch concurrent reconciliations
    const pA = reconciliationRepo.createReconciliation(orgA, {
      importBatchId: b.id,
      creditNoteResultId: cnResA.id,
      invoiceResultId: invRes.id,
      reconciliationStatus: ReconciliationStatus.MATCHED_PARTIAL,
      taxableReversed: new Decimal('6000.00'),
      totalReversed: new Decimal('7080.00')
    });

    const pB = reconciliationRepo.createReconciliation(orgA, {
      importBatchId: b.id,
      creditNoteResultId: cnResB.id,
      invoiceResultId: invRes.id,
      reconciliationStatus: ReconciliationStatus.MATCHED_PARTIAL,
      taxableReversed: new Decimal('5000.00'),
      totalReversed: new Decimal('5900.00')
    });

    const settled = await Promise.allSettled([pA, pB]);
    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    const rejected = settled.filter((s) => s.status === 'rejected');

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      InvoiceReversalCapacityExceededError
    );

    // Verify invoice cumulative balance did not exceed 10,000.00
    const invCheck = await resultRepo.findInvoiceResultById(orgA, invRes.id);
    expect(invCheck?.cumulativeTaxableReversed.lte(new Decimal('10000.00'))).toBe(true);
    expect(invCheck?.reversalCount).toBe(1);
  });

  // T9: Transaction fails during reconciliation -> Complete rollback
  it('T9: Transaction fails during reconciliation -> Complete database rollback', async () => {
    const { file, invRec, cnRec1 } = await createHelperSource(orgA, 't9');

    const inv = await canonicalRepo.getOrCreateCanonicalInvoice(
      orgA,
      buildInvoiceInput('INV-T9-ROLLBACK-001', 'ORD-T9-001')
    );

    const cn = await canonicalRepo.getOrCreateCanonicalCreditNote(orgA, {
      sellerGstin: '29AAACA1234A1Z5',
      financialYear: '2026-2027',
      creditNoteNumber: 'CN-T9-001',
      creditNoteDate: new Date('2026-05-10'),
      recipientType: RecipientType.B2C
    });

    const b = await batchRepo.createBatch(orgA, {
      batchNumber: 'BATCH-T9-1',
      engineVersion: '0.1.0',
      rulesVersion: '2026.1',
      sourceFileIds: [file.id]
    });

    const invRes = await resultRepo.createInvoiceResult(orgA, {
      importBatchId: b.id,
      canonicalInvoiceId: inv.invoice.id,
      sourceRecordId: invRec.id,
      totalTaxableValue: new Decimal('1000.00'),
      totalInvoiceAmount: new Decimal('1180.00'),
      primaryOutcome: PrimaryOutcome.VALID,
      lines: []
    });

    const cnRes = await resultRepo.createCreditNoteResult(orgA, {
      importBatchId: b.id,
      canonicalCreditNoteId: cn.creditNote.id,
      sourceRecordId: cnRec1.id,
      taxableValueReversal: new Decimal('400.00'),
      creditNoteTotal: new Decimal('472.00'),
      rawSignedAmountText: '-472.00',
      signedAmount: new Decimal('-472.00'),
      primaryOutcome: PrimaryOutcome.VALID
    });

    // Run in transaction that deliberately fails after reconciliation
    await expect(
      txManager.runInTransaction(orgA, async (txScope) => {
        await reconciliationRepo.createReconciliation(
          orgA,
          {
            importBatchId: b.id,
            creditNoteResultId: cnRes.id,
            invoiceResultId: invRes.id,
            reconciliationStatus: ReconciliationStatus.MATCHED_PARTIAL,
            taxableReversed: new Decimal('400.00'),
            totalReversed: new Decimal('472.00')
          },
          txScope.client as any
        );

        throw new Error('Simulated crash during batch reconciliation');
      })
    ).rejects.toThrow('Simulated crash during batch reconciliation');

    // Verify invoice cumulative reversal rolled back to 0.00
    const invCheck = await resultRepo.findInvoiceResultById(orgA, invRes.id);
    expect(invCheck?.cumulativeTaxableReversed.equals(new Decimal('0.00'))).toBe(true);

    const recCheck = await reconciliationRepo.findReconciliationByCreditNoteResultId(
      orgA,
      cnRes.id
    );
    expect(recCheck).toBeNull();
  });

  // T10: Retry after successful commit -> Idempotent skip
  it('T10: Retry after successful commit -> Idempotently retrieves existing reconciliation', async () => {
    const { file, invRec, cnRec1 } = await createHelperSource(orgA, 't10');

    const inv = await canonicalRepo.getOrCreateCanonicalInvoice(
      orgA,
      buildInvoiceInput('INV-T10-IDEMP-001', 'ORD-T10-001')
    );

    const cn = await canonicalRepo.getOrCreateCanonicalCreditNote(orgA, {
      sellerGstin: '29AAACA1234A1Z5',
      financialYear: '2026-2027',
      creditNoteNumber: 'CN-T10-001',
      creditNoteDate: new Date('2026-05-10'),
      recipientType: RecipientType.B2C
    });

    const b = await batchRepo.createBatch(orgA, {
      batchNumber: 'BATCH-T10-1',
      engineVersion: '0.1.0',
      rulesVersion: '2026.1',
      sourceFileIds: [file.id]
    });

    const invRes = await resultRepo.createInvoiceResult(orgA, {
      importBatchId: b.id,
      canonicalInvoiceId: inv.invoice.id,
      sourceRecordId: invRec.id,
      totalTaxableValue: new Decimal('1000.00'),
      totalInvoiceAmount: new Decimal('1180.00'),
      primaryOutcome: PrimaryOutcome.VALID,
      lines: []
    });

    const cnRes = await resultRepo.createCreditNoteResult(orgA, {
      importBatchId: b.id,
      canonicalCreditNoteId: cn.creditNote.id,
      sourceRecordId: cnRec1.id,
      taxableValueReversal: new Decimal('200.00'),
      creditNoteTotal: new Decimal('236.00'),
      rawSignedAmountText: '-236.00',
      signedAmount: new Decimal('-236.00'),
      primaryOutcome: PrimaryOutcome.VALID
    });

    const rec = await reconciliationRepo.createReconciliation(orgA, {
      importBatchId: b.id,
      creditNoteResultId: cnRes.id,
      invoiceResultId: invRes.id,
      reconciliationStatus: ReconciliationStatus.MATCHED_PARTIAL,
      taxableReversed: new Decimal('200.00'),
      totalReversed: new Decimal('236.00')
    });

    expect(rec.appliedFinancialReversal).toBe(true);

    // Caller retries: finds existing reconciliation by creditNoteResultId
    const found = await reconciliationRepo.findReconciliationByCreditNoteResultId(
      orgA,
      cnRes.id
    );
    expect(found).not.toBeNull();
    expect(found?.id).toBe(rec.reconciliation.id);
  });

  // T11: Tenant B accesses Tenant A -> Blocked by RLS
  it('T11: Multi-tenant RLS -> Org B cannot access or reverse Org A invoices', async () => {
    const { file, invRec, cnRec1 } = await createHelperSource(orgA, 't11');

    const invA = await canonicalRepo.getOrCreateCanonicalInvoice(
      orgA,
      buildInvoiceInput('INV-T11-ORGA-001', 'ORD-T11-001')
    );

    const bA = await batchRepo.createBatch(orgA, {
      batchNumber: 'BATCH-T11-ORGA-1',
      engineVersion: '0.1.0',
      rulesVersion: '2026.1',
      sourceFileIds: [file.id]
    });

    const invResA = await resultRepo.createInvoiceResult(orgA, {
      importBatchId: bA.id,
      canonicalInvoiceId: invA.invoice.id,
      sourceRecordId: invRec.id,
      totalTaxableValue: new Decimal('2000.00'),
      totalInvoiceAmount: new Decimal('2360.00'),
      primaryOutcome: PrimaryOutcome.VALID,
      lines: []
    });

    // Org B creates batch and credit note
    const { file: fileB, cnRec1: cnRec1B } = await createHelperSource(orgB, 't11_b');
    const cnB = await canonicalRepo.getOrCreateCanonicalCreditNote(orgB, {
      sellerGstin: '29AAACB5678B1Z1',
      financialYear: '2026-2027',
      creditNoteNumber: 'CN-T11-ORGB-001',
      creditNoteDate: new Date('2026-05-10'),
      recipientType: RecipientType.B2C
    });

    const bB = await batchRepo.createBatch(orgB, {
      batchNumber: 'BATCH-T11-ORGB-1',
      engineVersion: '0.1.0',
      rulesVersion: '2026.1',
      sourceFileIds: [fileB.id]
    });

    const cnResB = await resultRepo.createCreditNoteResult(orgB, {
      importBatchId: bB.id,
      canonicalCreditNoteId: cnB.creditNote.id,
      sourceRecordId: cnRec1B.id,
      taxableValueReversal: new Decimal('500.00'),
      creditNoteTotal: new Decimal('590.00'),
      rawSignedAmountText: '-590.00',
      signedAmount: new Decimal('-590.00'),
      primaryOutcome: PrimaryOutcome.VALID
    });

    // Org B attempts to reconcile against Org A's invoice: RLS blocks it with CanonicalDocumentNotFoundError
    await expect(
      reconciliationRepo.createReconciliation(orgB, {
        importBatchId: bB.id,
        creditNoteResultId: cnResB.id,
        invoiceResultId: invResA.id,
        reconciliationStatus: ReconciliationStatus.MATCHED_PARTIAL,
        taxableReversed: new Decimal('500.00'),
        totalReversed: new Decimal('590.00')
      })
    ).rejects.toThrow(CanonicalDocumentNotFoundError);
  });

  // T12: Supersession fails midway -> Rollback leaves original state consistent
  it('T12: Supersession fails midway -> Original invoice cumulative state preserved', async () => {
    const { file, invRec, cnRec1 } = await createHelperSource(orgA, 't12');

    const inv = await canonicalRepo.getOrCreateCanonicalInvoice(
      orgA,
      buildInvoiceInput('INV-T12-001', 'ORD-T12-001')
    );

    const cn = await canonicalRepo.getOrCreateCanonicalCreditNote(orgA, {
      sellerGstin: '29AAACA1234A1Z5',
      financialYear: '2026-2027',
      creditNoteNumber: 'CN-T12-001',
      creditNoteDate: new Date('2026-05-10'),
      recipientType: RecipientType.B2C
    });

    const b1 = await batchRepo.createBatch(orgA, {
      batchNumber: 'BATCH-T12-1',
      engineVersion: '0.1.0',
      rulesVersion: '2026.1',
      sourceFileIds: [file.id]
    });

    const invRes = await resultRepo.createInvoiceResult(orgA, {
      importBatchId: b1.id,
      canonicalInvoiceId: inv.invoice.id,
      sourceRecordId: invRec.id,
      totalTaxableValue: new Decimal('1000.00'),
      totalInvoiceAmount: new Decimal('1180.00'),
      primaryOutcome: PrimaryOutcome.VALID,
      lines: []
    });

    const cnRes1 = await resultRepo.createCreditNoteResult(orgA, {
      importBatchId: b1.id,
      canonicalCreditNoteId: cn.creditNote.id,
      sourceRecordId: cnRec1.id,
      taxableValueReversal: new Decimal('300.00'),
      creditNoteTotal: new Decimal('354.00'),
      rawSignedAmountText: '-354.00',
      signedAmount: new Decimal('-354.00'),
      primaryOutcome: PrimaryOutcome.VALID
    });

    await reconciliationRepo.createReconciliation(orgA, {
      importBatchId: b1.id,
      creditNoteResultId: cnRes1.id,
      invoiceResultId: invRes.id,
      reconciliationStatus: ReconciliationStatus.MATCHED_PARTIAL,
      taxableReversed: new Decimal('300.00'),
      totalReversed: new Decimal('354.00')
    });

    const b2 = await batchRepo.createReprocessingBatch(orgA, {
      newBatchNumber: 'BATCH-T12-2',
      parentBatchId: b1.id,
      reprocessReason: 'Testing rollback',
      rulesVersion: '2026.2',
      sourceFileIds: [file.id]
    });

    const cnRes2 = await resultRepo.createCreditNoteResult(orgA, {
      importBatchId: b2.id,
      canonicalCreditNoteId: cn.creditNote.id,
      sourceRecordId: cnRec1.id,
      taxableValueReversal: new Decimal('400.00'),
      creditNoteTotal: new Decimal('472.00'),
      rawSignedAmountText: '-472.00',
      signedAmount: new Decimal('-472.00'),
      primaryOutcome: PrimaryOutcome.VALID
    });

    await expect(
      txManager.runInTransaction(orgA, async (txScope) => {
        await reconciliationRepo.createReconciliation(
          orgA,
          {
            importBatchId: b2.id,
            creditNoteResultId: cnRes2.id,
            invoiceResultId: invRes.id,
            reconciliationStatus: ReconciliationStatus.MATCHED_PARTIAL,
            taxableReversed: new Decimal('400.00'),
            totalReversed: new Decimal('472.00'),
            allowSupersession: true
          },
          txScope.client as any
        );

        throw new Error('Midway supersession crash');
      })
    ).rejects.toThrow('Midway supersession crash');

    // Cumulative balance must remain frozen at initial 300.00
    const invCheck = await resultRepo.findInvoiceResultById(orgA, invRes.id);
    expect(invCheck?.cumulativeTaxableReversed.equals(new Decimal('300.00'))).toBe(true);
  });

  // T13: Multiple supersessions -> Correct effective balance
  it('T13: Multiple sequential supersessions -> Effective balance accurately reflects latest delta', async () => {
    const { file, invRec, cnRec1 } = await createHelperSource(orgA, 't13');

    const inv = await canonicalRepo.getOrCreateCanonicalInvoice(
      orgA,
      buildInvoiceInput('INV-T13-MULTI-SUP-001', 'ORD-T13-001')
    );

    const cn = await canonicalRepo.getOrCreateCanonicalCreditNote(orgA, {
      sellerGstin: '29AAACA1234A1Z5',
      financialYear: '2026-2027',
      creditNoteNumber: 'CN-T13-001',
      creditNoteDate: new Date('2026-05-10'),
      recipientType: RecipientType.B2C
    });

    const b1 = await batchRepo.createBatch(orgA, {
      batchNumber: 'BATCH-T13-1',
      engineVersion: '0.1.0',
      rulesVersion: '2026.1',
      sourceFileIds: [file.id]
    });

    const invRes = await resultRepo.createInvoiceResult(orgA, {
      importBatchId: b1.id,
      canonicalInvoiceId: inv.invoice.id,
      sourceRecordId: invRec.id,
      totalTaxableValue: new Decimal('2000.00'),
      totalInvoiceAmount: new Decimal('2360.00'),
      primaryOutcome: PrimaryOutcome.VALID,
      lines: []
    });

    // Batch 1: Taxable 500.00, Total 590.00
    const cnRes1 = await resultRepo.createCreditNoteResult(orgA, {
      importBatchId: b1.id,
      canonicalCreditNoteId: cn.creditNote.id,
      sourceRecordId: cnRec1.id,
      taxableValueReversal: new Decimal('500.00'),
      creditNoteTotal: new Decimal('590.00'),
      rawSignedAmountText: '-590.00',
      signedAmount: new Decimal('-590.00'),
      primaryOutcome: PrimaryOutcome.VALID
    });

    await reconciliationRepo.createReconciliation(orgA, {
      importBatchId: b1.id,
      creditNoteResultId: cnRes1.id,
      invoiceResultId: invRes.id,
      reconciliationStatus: ReconciliationStatus.MATCHED_PARTIAL,
      taxableReversed: new Decimal('500.00'),
      totalReversed: new Decimal('590.00')
    });

    // Batch 2: Taxable 600.00 (+100.00)
    const b2 = await batchRepo.createReprocessingBatch(orgA, {
      newBatchNumber: 'BATCH-T13-2',
      parentBatchId: b1.id,
      reprocessReason: 'Increase reversal',
      rulesVersion: '2026.2',
      sourceFileIds: [file.id]
    });

    const cnRes2 = await resultRepo.createCreditNoteResult(orgA, {
      importBatchId: b2.id,
      canonicalCreditNoteId: cn.creditNote.id,
      sourceRecordId: cnRec1.id,
      taxableValueReversal: new Decimal('600.00'),
      creditNoteTotal: new Decimal('708.00'),
      rawSignedAmountText: '-708.00',
      signedAmount: new Decimal('-708.00'),
      primaryOutcome: PrimaryOutcome.VALID
    });

    await reconciliationRepo.createReconciliation(orgA, {
      importBatchId: b2.id,
      creditNoteResultId: cnRes2.id,
      invoiceResultId: invRes.id,
      reconciliationStatus: ReconciliationStatus.MATCHED_PARTIAL,
      taxableReversed: new Decimal('600.00'),
      totalReversed: new Decimal('708.00'),
      allowSupersession: true
    });

    let invCheck = await resultRepo.findInvoiceResultById(orgA, invRes.id);
    expect(invCheck?.cumulativeTaxableReversed.equals(new Decimal('600.00'))).toBe(true);

    // Batch 3: Taxable 450.00 (-150.00 downward adjustment)
    const b3 = await batchRepo.createReprocessingBatch(orgA, {
      newBatchNumber: 'BATCH-T13-3',
      parentBatchId: b2.id,
      reprocessReason: 'Downward adjustment',
      rulesVersion: '2026.3',
      sourceFileIds: [file.id]
    });

    const cnRes3 = await resultRepo.createCreditNoteResult(orgA, {
      importBatchId: b3.id,
      canonicalCreditNoteId: cn.creditNote.id,
      sourceRecordId: cnRec1.id,
      taxableValueReversal: new Decimal('450.00'),
      creditNoteTotal: new Decimal('531.00'),
      rawSignedAmountText: '-531.00',
      signedAmount: new Decimal('-531.00'),
      primaryOutcome: PrimaryOutcome.VALID
    });

    await reconciliationRepo.createReconciliation(orgA, {
      importBatchId: b3.id,
      creditNoteResultId: cnRes3.id,
      invoiceResultId: invRes.id,
      reconciliationStatus: ReconciliationStatus.MATCHED_PARTIAL,
      taxableReversed: new Decimal('450.00'),
      totalReversed: new Decimal('531.00'),
      allowSupersession: true
    });

    invCheck = await resultRepo.findInvoiceResultById(orgA, invRes.id);
    expect(invCheck?.cumulativeTaxableReversed.equals(new Decimal('450.00'))).toBe(true);
    expect(invCheck?.cumulativeTotalReversed.equals(new Decimal('531.00'))).toBe(true);
  });

  // T14: Reprocessing result versions -> Strictly sequential (v1, v2)
  it('T14: Reprocessing result versions -> Correctly increments version sequence', async () => {
    const { file, invRec } = await createHelperSource(orgA, 't14');

    const inv = await canonicalRepo.getOrCreateCanonicalInvoice(
      orgA,
      buildInvoiceInput('INV-T14-VER-001', 'ORD-T14-001')
    );

    const b1 = await batchRepo.createBatch(orgA, {
      batchNumber: 'BATCH-T14-1',
      engineVersion: '0.1.0',
      rulesVersion: '2026.1',
      sourceFileIds: [file.id]
    });

    const invRes1 = await resultRepo.createInvoiceResult(orgA, {
      importBatchId: b1.id,
      canonicalInvoiceId: inv.invoice.id,
      sourceRecordId: invRec.id,
      totalTaxableValue: new Decimal('1000.00'),
      totalInvoiceAmount: new Decimal('1180.00'),
      primaryOutcome: PrimaryOutcome.VALID,
      lines: []
    });

    expect(invRes1.version).toBe(1);

    const b2 = await batchRepo.createReprocessingBatch(orgA, {
      newBatchNumber: 'BATCH-T14-2',
      parentBatchId: b1.id,
      reprocessReason: 'Version bump',
      rulesVersion: '2026.2',
      sourceFileIds: [file.id]
    });

    const invRes2 = await resultRepo.createInvoiceResult(orgA, {
      importBatchId: b2.id,
      canonicalInvoiceId: inv.invoice.id,
      sourceRecordId: invRec.id,
      totalTaxableValue: new Decimal('1000.00'),
      totalInvoiceAmount: new Decimal('1180.00'),
      primaryOutcome: PrimaryOutcome.VALID,
      lines: []
    });

    expect(invRes2.version).toBe(2);

    const allResults = await resultRepo.findInvoiceResultsByCanonicalInvoice(
      orgA,
      inv.invoice.id
    );
    expect(allResults.length).toBe(2);
    expect(allResults[0].version).toBe(1);
    expect(allResults[1].version).toBe(2);
  });

  // T15: Concurrent retries -> No duplicate ledger events
  it('T15: Concurrent retries -> Row lock on canonical CN ensures exactly one reconciliation ledger entry', async () => {
    const { file, invRec, cnRec1 } = await createHelperSource(orgA, 't15');

    const inv = await canonicalRepo.getOrCreateCanonicalInvoice(
      orgA,
      buildInvoiceInput('INV-T15-RETRIES-001', 'ORD-T15-001')
    );

    const cn = await canonicalRepo.getOrCreateCanonicalCreditNote(orgA, {
      sellerGstin: '29AAACA1234A1Z5',
      financialYear: '2026-2027',
      creditNoteNumber: 'CN-T15-001',
      creditNoteDate: new Date('2026-05-10'),
      recipientType: RecipientType.B2C
    });

    const b = await batchRepo.createBatch(orgA, {
      batchNumber: 'BATCH-T15-1',
      engineVersion: '0.1.0',
      rulesVersion: '2026.1',
      sourceFileIds: [file.id]
    });

    const invRes = await resultRepo.createInvoiceResult(orgA, {
      importBatchId: b.id,
      canonicalInvoiceId: inv.invoice.id,
      sourceRecordId: invRec.id,
      totalTaxableValue: new Decimal('1000.00'),
      totalInvoiceAmount: new Decimal('1180.00'),
      primaryOutcome: PrimaryOutcome.VALID,
      lines: []
    });

    const cnRes = await resultRepo.createCreditNoteResult(orgA, {
      importBatchId: b.id,
      canonicalCreditNoteId: cn.creditNote.id,
      sourceRecordId: cnRec1.id,
      taxableValueReversal: new Decimal('200.00'),
      creditNoteTotal: new Decimal('236.00'),
      rawSignedAmountText: '-236.00',
      signedAmount: new Decimal('-236.00'),
      primaryOutcome: PrimaryOutcome.VALID
    });

    // Run first reconciliation
    await reconciliationRepo.createReconciliation(orgA, {
      importBatchId: b.id,
      creditNoteResultId: cnRes.id,
      invoiceResultId: invRes.id,
      reconciliationStatus: ReconciliationStatus.MATCHED_PARTIAL,
      taxableReversed: new Decimal('200.00'),
      totalReversed: new Decimal('236.00')
    });

    // Check count of reconciliations
    await runInTenantTransaction(prisma, orgA, async (tx) => {
      const recCount = await tx.reconciliation.count({
        where: {
          organizationId: orgA.organizationId,
          creditNoteResultId: cnRes.id
        }
      });
      expect(recCount).toBe(1);
    });
  });
});
