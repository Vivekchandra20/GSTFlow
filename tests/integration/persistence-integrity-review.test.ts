import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import { Decimal } from '../../src/utils/decimal.js';
import {
  PrismaSourceRecordRepository,
  PrismaImportBatchRepository,
  PrismaCanonicalDocumentRepository,
  PrismaProcessingResultRepository,
  PrismaReconciliationRepository,
  TenantContext,
  RecordType,
  BatchStatus,
  PrimaryOutcome,
  DuplicateProcessingResultError,
  CanonicalCreditNoteAlreadyReconciledError,
  runInTenantTransaction
} from '../../src/repositories/index.js';
import {
  RecipientType,
  SupplyType,
  StockTransferClassification,
  ReconciliationStatus
} from '../../src/models/enums.js';

describe('Phase 3B: Persistence Integrity Review Suite', () => {
  let pgServer: any;
  let adminClient: pg.Client;
  let prisma: PrismaClient;

  let sourceRepo: PrismaSourceRecordRepository;
  let batchRepo: PrismaImportBatchRepository;
  let canonicalRepo: PrismaCanonicalDocumentRepository;
  let resultRepo: PrismaProcessingResultRepository;
  let reconciliationRepo: PrismaReconciliationRepository;

  const testDbName = 'gstflow_integrity_test_db';
  const testPort = 54336;
  const dataDir = path.resolve('.pgdata_phase3b3_integrity');

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
        ('${orgA.organizationId}', 'Integrity Review Org A', 'AAACA1234A', 72, NOW(), NOW()),
        ('${orgB.organizationId}', 'Integrity Review Org B', 'AAACB5678B', 72, NOW(), NOW());
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
    canonicalRepo = new PrismaCanonicalDocumentRepository(prisma);
    resultRepo = new PrismaProcessingResultRepository(prisma);
    reconciliationRepo = new PrismaReconciliationRepository(prisma);
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
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  });

  async function setupSource(ctx: TenantContext, tag: string) {
    const file = await sourceRepo.createSourceFile(ctx, {
      fileName: `file_${tag}.csv`,
      fileFingerprint: `fp_${tag}_${Date.now()}`,
      fileSizeBytes: 5000n,
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
        rawPayload: { tag, type: 'CN' }
      }
    ]);

    const records = await sourceRepo.findRecordsBySourceFile(ctx, file.id);
    return { file, invRec: records[0], cnRec: records[1] };
  }

  // ==========================================
  // REVIEW 1: CANONICAL CREDIT-NOTE RECONCILIATION IDENTITY
  // ==========================================
  describe('1. Canonical credit-note reconciliation identity & supersession', () => {
    it('prevents double financial reconciliation of same canonical credit note across reprocessed batches', async () => {
      const { file, invRec, cnRec } = await setupSource(orgA, 'cn_double_reconcile');

      // 1. Create Canonical Documents
      const invCanonical = await canonicalRepo.getOrCreateCanonicalInvoice(orgA, {
        sellerGstin: '29AAACA1234A1Z5',
        financialYear: '2026-2027',
        invoiceNumber: 'INV-DOUBLE-SPEND-001',
        invoiceDate: new Date('2026-05-10'),
        orderId: 'ORD-DOUBLE-1',
        recipientType: RecipientType.B2C,
        shipFromStateCode: '29',
        placeOfSupplyStateCode: '29',
        supplyType: SupplyType.INTRASTATE
      });

      const cnCanonical = await canonicalRepo.getOrCreateCanonicalCreditNote(orgA, {
        sellerGstin: '29AAACA1234A1Z5',
        financialYear: '2026-2027',
        creditNoteNumber: 'CN-DOUBLE-SPEND-001',
        creditNoteDate: new Date('2026-05-15'),
        originalInvoiceNumber: 'INV-DOUBLE-SPEND-001',
        recipientType: RecipientType.B2C
      });

      // 2. Batch 1 Processing & Reconciliation
      const batch1 = await batchRepo.createBatch(orgA, {
        batchNumber: 'BATCH-REC-RUN-1',
        engineVersion: '0.1.0',
        rulesVersion: '2026.1',
        sourceFileIds: [file.id]
      });

      const invRes1 = await resultRepo.createInvoiceResult(orgA, {
        importBatchId: batch1.id,
        canonicalInvoiceId: invCanonical.invoice.id,
        sourceRecordId: invRec.id,
        totalTaxableValue: new Decimal('10000.00'),
        cgstAmount: new Decimal('900.00'),
        sgstAmount: new Decimal('900.00'),
        totalInvoiceAmount: new Decimal('11800.00'),
        primaryOutcome: PrimaryOutcome.VALID,
        lines: []
      });

      const cnRes1 = await resultRepo.createCreditNoteResult(orgA, {
        importBatchId: batch1.id,
        canonicalCreditNoteId: cnCanonical.creditNote.id,
        sourceRecordId: cnRec.id,
        taxableValueReversal: new Decimal('2000.00'),
        cgstAmountReversal: new Decimal('180.00'),
        sgstAmountReversal: new Decimal('180.00'),
        creditNoteTotal: new Decimal('2360.00'),
        rawSignedAmountText: '-2360.00',
        signedAmount: new Decimal('-2360.00'),
        primaryOutcome: PrimaryOutcome.VALID
      });

      // Apply initial reconciliation in Batch 1
      const recResult1 = await reconciliationRepo.createReconciliation(orgA, {
        importBatchId: batch1.id,
        creditNoteResultId: cnRes1.id,
        invoiceResultId: invRes1.id,
        reconciliationStatus: ReconciliationStatus.MATCHED_PARTIAL,
        taxableReversed: new Decimal('2000.00'),
        totalReversed: new Decimal('2360.00')
      });

      expect(recResult1.appliedFinancialReversal).toBe(true);
      expect(recResult1.isSuperseded).toBe(false);

      // Verify invoice cumulative reversal was updated to ₹2000.00
      const invAfterBatch1 = await resultRepo.findInvoiceResultById(orgA, invRes1.id);
      expect(invAfterBatch1?.cumulativeTaxableReversed.equals(new Decimal('2000.00'))).toBe(true);
      expect(invAfterBatch1?.reversalCount).toBe(1);

      // Complete Batch 1
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
        BatchStatus.COMPLETED
      );

      // 3. Batch 2 Reprocessing
      const batch2 = await batchRepo.createReprocessingBatch(orgA, {
        newBatchNumber: 'BATCH-REC-RUN-2',
        parentBatchId: batch1.id,
        reprocessReason: 'Statutory rules reprocessing',
        rulesVersion: '2026.2',
        sourceFileIds: [file.id]
      });

      // Reprocess creates new version of invoice result and credit note result
      const invRes2 = await resultRepo.createInvoiceResult(orgA, {
        importBatchId: batch2.id,
        canonicalInvoiceId: invCanonical.invoice.id,
        sourceRecordId: invRec.id,
        totalTaxableValue: new Decimal('10000.00'),
        cgstAmount: new Decimal('900.00'),
        sgstAmount: new Decimal('900.00'),
        totalInvoiceAmount: new Decimal('11800.00'),
        primaryOutcome: PrimaryOutcome.VALID,
        lines: []
      });

      const cnRes2 = await resultRepo.createCreditNoteResult(orgA, {
        importBatchId: batch2.id,
        canonicalCreditNoteId: cnCanonical.creditNote.id,
        sourceRecordId: cnRec.id,
        taxableValueReversal: new Decimal('2000.00'),
        cgstAmountReversal: new Decimal('180.00'),
        sgstAmountReversal: new Decimal('180.00'),
        creditNoteTotal: new Decimal('2360.00'),
        rawSignedAmountText: '-2360.00',
        signedAmount: new Decimal('-2360.00'),
        primaryOutcome: PrimaryOutcome.VALID
      });

      // 4. ATTEMPT SECOND RECONCILIATION WITHOUT SUPERSESSION:
      // Must be rejected with CanonicalCreditNoteAlreadyReconciledError!
      await expect(
        reconciliationRepo.createReconciliation(orgA, {
          importBatchId: batch2.id,
          creditNoteResultId: cnRes2.id,
          invoiceResultId: invRes2.id,
          reconciliationStatus: ReconciliationStatus.MATCHED_PARTIAL,
          taxableReversed: new Decimal('2000.00'),
          totalReversed: new Decimal('2360.00')
        })
      ).rejects.toThrow(CanonicalCreditNoteAlreadyReconciledError);

      // 5. RECONCILE WITH EXPLICIT SUPERSESSION SEMANTICS:
      const supersessionResult = await reconciliationRepo.createReconciliation(orgA, {
        importBatchId: batch2.id,
        creditNoteResultId: cnRes2.id,
        invoiceResultId: invRes2.id,
        reconciliationStatus: ReconciliationStatus.MATCHED_PARTIAL,
        taxableReversed: new Decimal('2000.00'),
        totalReversed: new Decimal('2360.00'),
        allowSupersession: true
      });

      expect(supersessionResult.isSuperseded).toBe(true);
      expect(supersessionResult.appliedFinancialReversal).toBe(false);
      expect(supersessionResult.reconciliation.id).toBe(recResult1.reconciliation.id);

      // 6. VERIFY INVOICE CUMULATIVE REVERSAL WAS NOT ALTERED / DOUBLED:
      // Target invoice cumulative reversal must remain 0.00 (on new version) or exactly 2000.00,
      // absolutely NEVER doubled to 4000.00!
      const invAfterBatch2 = await resultRepo.findInvoiceResultById(orgA, invRes2.id);
      expect(invAfterBatch2?.cumulativeTaxableReversed.equals(new Decimal('0.00'))).toBe(true);

      const inv1Frozen = await resultRepo.findInvoiceResultById(orgA, invRes1.id);
      expect(inv1Frozen?.cumulativeTaxableReversed.equals(new Decimal('2000.00'))).toBe(true);
    });
  });

  // ==========================================
  // REVIEW 2: CANONICAL IDENTITY CONFLICTS
  // ==========================================
  describe('2. Canonical identity conflicts', () => {
    const baseInvoice = {
      sellerGstin: '29AAACA1234A1Z5',
      financialYear: '2026-2027',
      invoiceNumber: 'INV-CONFLICT-TEST-001',
      invoiceDate: new Date('2026-05-10'),
      orderId: 'ORD-CONFLICT-1',
      recipientType: RecipientType.B2C,
      customerGstin: null,
      shipFromStateCode: '29',
      placeOfSupplyStateCode: '29',
      supplyType: SupplyType.INTRASTATE
    };

    it('returns hasConflict: false when document identity and attributes are identical', async () => {
      const first = await canonicalRepo.getOrCreateCanonicalInvoice(orgA, baseInvoice);
      expect(first.isNew).toBe(true);
      expect(first.hasConflict).toBe(false);
      expect(first.conflictDetails?.length).toBe(0);

      const second = await canonicalRepo.getOrCreateCanonicalInvoice(orgA, baseInvoice);
      expect(second.isNew).toBe(false);
      expect(second.hasConflict).toBe(false);
      expect(second.invoice.id).toBe(first.invoice.id);
    });

    it('detects buyer GSTIN conflict without overwriting existing canonical record', async () => {
      const conflictingInput = {
        ...baseInvoice,
        customerGstin: '29XYZAB5678C1Z9' // Different buyer GSTIN!
      };

      const result = await canonicalRepo.getOrCreateCanonicalInvoice(orgA, conflictingInput);
      expect(result.isNew).toBe(false);
      expect(result.hasConflict).toBe(true);
      expect(result.conflictDetails?.length).toBe(1);
      expect(result.conflictDetails?.[0].conflictType).toBe('BUYER_GSTIN_MISMATCH');
      expect(result.conflictDetails?.[0].incomingValue).toBe('29XYZAB5678C1Z9');

      // Canonical record remains frozen with original null customerGstin
      const rechecked = await canonicalRepo.findCanonicalInvoiceById(orgA, result.invoice.id);
      expect(rechecked?.customerGstin).toBeNull();
    });

    it('detects invoice date conflict without overwriting existing canonical record', async () => {
      const conflictingInput = {
        ...baseInvoice,
        invoiceDate: new Date('2026-05-25') // Different invoice date!
      };

      const result = await canonicalRepo.getOrCreateCanonicalInvoice(orgA, conflictingInput);
      expect(result.isNew).toBe(false);
      expect(result.hasConflict).toBe(true);
      expect(result.conflictDetails?.[0].conflictType).toBe('INVOICE_DATE_MISMATCH');

      // Canonical record remains frozen with original date 2026-05-10
      const rechecked = await canonicalRepo.findCanonicalInvoiceById(orgA, result.invoice.id);
      expect(rechecked?.invoiceDate.toISOString().slice(0, 10)).toBe('2026-05-10');
    });

    it('detects document/recipient type conflict without overwriting existing canonical record', async () => {
      const conflictingInput = {
        ...baseInvoice,
        recipientType: RecipientType.B2B // Different document type!
      };

      const result = await canonicalRepo.getOrCreateCanonicalInvoice(orgA, conflictingInput);
      expect(result.isNew).toBe(false);
      expect(result.hasConflict).toBe(true);
      expect(result.conflictDetails?.[0].conflictType).toBe('DOCUMENT_TYPE_MISMATCH');

      const rechecked = await canonicalRepo.findCanonicalInvoiceById(orgA, result.invoice.id);
      expect(rechecked?.recipientType).toBe(RecipientType.B2C);
    });

    it('detects identity conflicts in credit notes and stock transfers', async () => {
      const baseCn = {
        sellerGstin: '29AAACA1234A1Z5',
        financialYear: '2026-2027',
        creditNoteNumber: 'CN-CONFLICT-001',
        creditNoteDate: new Date('2026-05-15'),
        originalInvoiceNumber: 'INV-100',
        recipientType: RecipientType.B2C
      };

      await canonicalRepo.getOrCreateCanonicalCreditNote(orgA, baseCn);

      // Conflicting original invoice number
      const cnConflict = await canonicalRepo.getOrCreateCanonicalCreditNote(orgA, {
        ...baseCn,
        originalInvoiceNumber: 'INV-DIFFERENT-999'
      });
      expect(cnConflict.hasConflict).toBe(true);
      expect(cnConflict.conflictDetails?.[0].conflictType).toBe(
        'ORIGINAL_INVOICE_NUMBER_MISMATCH'
      );

      const baseTr = {
        sourceGstin: '29AAACA1234A1Z5',
        financialYear: '2026-2027',
        transferInvoiceNumber: 'TR-CONFLICT-001',
        transferDate: new Date('2026-05-20'),
        destinationGstin: '27AAACA1234A1Z6',
        sourcePan: 'AAACA1234A',
        destinationPan: 'AAACA1234A',
        shipFromStateCode: '29',
        shipToStateCode: '27'
      };

      await canonicalRepo.getOrCreateCanonicalStockTransfer(orgA, baseTr);

      // Conflicting destination GSTIN
      const trConflict = await canonicalRepo.getOrCreateCanonicalStockTransfer(orgA, {
        ...baseTr,
        destinationGstin: '33AAACA1234A1Z1'
      });
      expect(trConflict.hasConflict).toBe(true);
      expect(trConflict.conflictDetails?.[0].conflictType).toBe(
        'DESTINATION_GSTIN_MISMATCH'
      );
    });
  });

  // ==========================================
  // REVIEW 3: CONCURRENT PROCESSING VERSION ALLOCATION
  // ==========================================
  describe('3. Concurrent processing version allocation', () => {
    it('allocates strictly unique, non-colliding version numbers across concurrent workers', async () => {
      const { file, invRec } = await setupSource(orgA, 'concur_version');

      const canonical = await canonicalRepo.getOrCreateCanonicalInvoice(orgA, {
        sellerGstin: '29AAACA1234A1Z5',
        financialYear: '2026-2027',
        invoiceNumber: 'INV-CONCUR-VER-001',
        invoiceDate: new Date('2026-05-20'),
        orderId: 'ORD-CONCUR-VER',
        recipientType: RecipientType.B2C,
        shipFromStateCode: '29',
        placeOfSupplyStateCode: '29',
        supplyType: SupplyType.INTRASTATE
      });

      // Create two distinct batches to process concurrently
      const batchA = await batchRepo.createBatch(orgA, {
        batchNumber: `BATCH-CONCUR-A-${Date.now()}`,
        engineVersion: '0.1.0',
        rulesVersion: '2026.1',
        sourceFileIds: [file.id]
      });

      const batchB = await batchRepo.createBatch(orgA, {
        batchNumber: `BATCH-CONCUR-B-${Date.now()}`,
        engineVersion: '0.2.0',
        rulesVersion: '2026.2',
        sourceFileIds: [file.id]
      });

      // Simulate 2 parallel workers allocating versions simultaneously
      const [resA, resB] = await Promise.all([
        resultRepo.createInvoiceResult(orgA, {
          importBatchId: batchA.id,
          canonicalInvoiceId: canonical.invoice.id,
          sourceRecordId: invRec.id,
          totalTaxableValue: new Decimal('1000.00'),
          totalInvoiceAmount: new Decimal('1180.00'),
          primaryOutcome: PrimaryOutcome.VALID,
          lines: []
        }),
        resultRepo.createInvoiceResult(orgA, {
          importBatchId: batchB.id,
          canonicalInvoiceId: canonical.invoice.id,
          sourceRecordId: invRec.id,
          totalTaxableValue: new Decimal('1000.00'),
          totalInvoiceAmount: new Decimal('1180.00'),
          primaryOutcome: PrimaryOutcome.VALID,
          lines: []
        })
      ]);

      // Assert unique version numbers
      expect(resA.version).not.toBe(resB.version);
      const versions = [resA.version, resB.version].sort((a, b) => a - b);
      expect(versions).toEqual([1, 2]); // Exactly versions 1 and 2, zero duplicates!

      // Assert neither result overwrote the other
      const allResults = await resultRepo.findInvoiceResultsByCanonicalInvoice(
        orgA,
        canonical.invoice.id
      );
      expect(allResults.length).toBe(2);
      expect(allResults[0].id).not.toBe(allResults[1].id);
    });

    it('deterministically rejects duplicate version attempts in the same batch', async () => {
      const { file, invRec } = await setupSource(orgA, 'same_batch_dup');

      const canonical = await canonicalRepo.getOrCreateCanonicalInvoice(orgA, {
        sellerGstin: '29AAACA1234A1Z5',
        financialYear: '2026-2027',
        invoiceNumber: 'INV-SAME-BATCH-001',
        invoiceDate: new Date('2026-05-22'),
        orderId: 'ORD-SAME-BATCH',
        recipientType: RecipientType.B2C,
        shipFromStateCode: '29',
        placeOfSupplyStateCode: '29',
        supplyType: SupplyType.INTRASTATE
      });

      const batch = await batchRepo.createBatch(orgA, {
        batchNumber: `BATCH-SAME-${Date.now()}`,
        engineVersion: '0.1.0',
        rulesVersion: '2026.1',
        sourceFileIds: [file.id]
      });

      // Insert first result
      await resultRepo.createInvoiceResult(orgA, {
        importBatchId: batch.id,
        canonicalInvoiceId: canonical.invoice.id,
        sourceRecordId: invRec.id,
        totalTaxableValue: new Decimal('500.00'),
        totalInvoiceAmount: new Decimal('590.00'),
        primaryOutcome: PrimaryOutcome.VALID,
        lines: []
      });

      // Second attempt in exact same batch must fail deterministically
      await expect(
        resultRepo.createInvoiceResult(orgA, {
          importBatchId: batch.id,
          canonicalInvoiceId: canonical.invoice.id,
          sourceRecordId: invRec.id,
          totalTaxableValue: new Decimal('500.00'),
          totalInvoiceAmount: new Decimal('590.00'),
          primaryOutcome: PrimaryOutcome.VALID,
          lines: []
        })
      ).rejects.toThrow(DuplicateProcessingResultError);
    });
  });
});
