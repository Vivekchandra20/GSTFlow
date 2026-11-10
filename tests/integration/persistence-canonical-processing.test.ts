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
  TenantContext,
  RecordType,
  BatchStatus,
  PrimaryOutcome,
  DuplicateProcessingResultError,
  CanonicalDocumentNotFoundError,
  runInTenantTransaction
} from '../../src/repositories/index.js';
import {
  RecipientType,
  SupplyType,
  StockTransferClassification,
  ReconciliationStatus
} from '../../src/models/enums.js';

describe('Phase 3B.3.2: PostgreSQL Canonical Documents & Processing Results Integration Suite', () => {
  let pgServer: any;
  let adminClient: pg.Client;
  let prisma: PrismaClient;

  let sourceRepo: PrismaSourceRecordRepository;
  let batchRepo: PrismaImportBatchRepository;
  let canonicalRepo: PrismaCanonicalDocumentRepository;
  let resultRepo: PrismaProcessingResultRepository;

  const testDbName = 'gstflow_canonical_test_db';
  const testPort = 54335;
  const dataDir = path.resolve('.pgdata_phase3b32');

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
        ('${orgA.organizationId}', 'Tenant A Retail Ltd', 'AAACA1234A', 72, NOW(), NOW()),
        ('${orgB.organizationId}', 'Tenant B Logistics Ltd', 'AAACB5678B', 72, NOW(), NOW());
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

  // Helper to quickly create a source file and record
  async function setupSourceRecord(ctx: TenantContext, suffix: string) {
    const file = await sourceRepo.createSourceFile(ctx, {
      fileName: `test_file_${suffix}.csv`,
      fileFingerprint: `fp_${suffix}_${Date.now()}`,
      fileSizeBytes: 1000n,
      storageUri: `s3://vault/${suffix}.csv`,
      sourceReportType: 'AMAZON_MTR'
    });

    await sourceRepo.bulkInsertSourceRecords(ctx, file.id, [
      {
        physicalLineNumber: 2,
        logicalRecordNumber: 1,
        recordType: RecordType.OUTWARD_SUPPLY,
        rawPayload: { row: suffix }
      }
    ]);

    const records = await sourceRepo.findRecordsBySourceFile(ctx, file.id);
    return { file, record: records[0] };
  }

  // ==========================================
  // REQUIREMENT 1: CANONICAL DOCUMENT IDEMPOTENCY
  // ==========================================
  describe('1. Canonical document idempotency', () => {
    it('creates canonical invoice on first call and retrieves existing on subsequent call', async () => {
      const input = {
        sellerGstin: '29AAACA1234A1Z5',
        financialYear: '2026-2027',
        invoiceNumber: 'INV-IDEM-001',
        invoiceDate: new Date('2026-05-10'),
        orderId: 'ORD-IDEM-100',
        recipientType: RecipientType.B2C,
        shipFromStateCode: '29',
        placeOfSupplyStateCode: '29',
        supplyType: SupplyType.INTRASTATE
      };

      const res1 = await canonicalRepo.getOrCreateCanonicalInvoice(orgA, input);
      expect(res1.isNew).toBe(true);
      expect(res1.invoice.id).toBeDefined();
      expect(res1.invoice.sellerGstin).toBe('29AAACA1234A1Z5');

      // Subsequent call with exact same identity
      const res2 = await canonicalRepo.getOrCreateCanonicalInvoice(orgA, input);
      expect(res2.isNew).toBe(false);
      expect(res2.invoice.id).toBe(res1.invoice.id);

      // Verify lookup by business key
      const found = await canonicalRepo.findCanonicalInvoice(
        orgA,
        '29AAACA1234A1Z5',
        '2026-2027',
        'INV-IDEM-001'
      );
      expect(found?.id).toBe(res1.invoice.id);
    });

    it('creates canonical credit note and stock transfer idempotently', async () => {
      const cnInput = {
        sellerGstin: '29AAACA1234A1Z5',
        financialYear: '2026-2027',
        creditNoteNumber: 'CN-IDEM-001',
        creditNoteDate: new Date('2026-05-15'),
        originalInvoiceNumber: 'INV-IDEM-001',
        recipientType: RecipientType.B2C
      };

      const cn1 = await canonicalRepo.getOrCreateCanonicalCreditNote(orgA, cnInput);
      expect(cn1.isNew).toBe(true);

      const cn2 = await canonicalRepo.getOrCreateCanonicalCreditNote(orgA, cnInput);
      expect(cn2.isNew).toBe(false);
      expect(cn2.creditNote.id).toBe(cn1.creditNote.id);

      const trInput = {
        sourceGstin: '29AAACA1234A1Z5',
        financialYear: '2026-2027',
        transferInvoiceNumber: 'TR-IDEM-001',
        transferDate: new Date('2026-05-20'),
        destinationGstin: '27AAACA1234A1Z6',
        sourcePan: 'AAACA1234A',
        destinationPan: 'AAACA1234A',
        shipFromStateCode: '29',
        shipToStateCode: '27'
      };

      const tr1 = await canonicalRepo.getOrCreateCanonicalStockTransfer(orgA, trInput);
      expect(tr1.isNew).toBe(true);

      const tr2 = await canonicalRepo.getOrCreateCanonicalStockTransfer(orgA, trInput);
      expect(tr2.isNew).toBe(false);
      expect(tr2.transfer.id).toBe(tr1.transfer.id);
    });
  });

  // ==========================================
  // REQUIREMENT 2: SAME DOCUMENT IDENTITY ACROSS SEPARATE ORGANIZATIONS
  // ==========================================
  describe('2. Same document identity across separate organizations', () => {
    it('allows same document identity across different tenants with complete isolation', async () => {
      const sharedInput = {
        sellerGstin: '29AAACA1234A1Z5',
        financialYear: '2026-2027',
        invoiceNumber: 'INV-SHARED-001',
        invoiceDate: new Date('2026-05-12'),
        orderId: 'ORD-SHARED-1',
        recipientType: RecipientType.B2C,
        shipFromStateCode: '29',
        placeOfSupplyStateCode: '29',
        supplyType: SupplyType.INTRASTATE
      };

      const resA = await canonicalRepo.getOrCreateCanonicalInvoice(orgA, sharedInput);
      const resB = await canonicalRepo.getOrCreateCanonicalInvoice(orgB, sharedInput);

      expect(resA.isNew).toBe(true);
      expect(resB.isNew).toBe(true);
      expect(resA.invoice.id).not.toBe(resB.invoice.id);
      expect(resA.invoice.organizationId).toBe(orgA.organizationId);
      expect(resB.invoice.organizationId).toBe(orgB.organizationId);

      // Tenant A cannot query Tenant B's canonical invoice by ID
      const crossFetch = await canonicalRepo.findCanonicalInvoiceById(orgA, resB.invoice.id);
      expect(crossFetch).toBeNull();
    });
  });

  // ==========================================
  // REQUIREMENT 3 & 4: MULTIPLE PROCESSING VERSIONS & HISTORICAL IMMUTABILITY
  // ==========================================
  describe('3 & 4. Multiple processing versions and historical result immutability', () => {
    it('creates versioned execution results for same canonical invoice without overwriting', async () => {
      const { file, record } = await setupSourceRecord(orgA, 'v1v2');

      const canonical = await canonicalRepo.getOrCreateCanonicalInvoice(orgA, {
        sellerGstin: '29AAACA1234A1Z5',
        financialYear: '2026-2027',
        invoiceNumber: 'INV-VERSION-001',
        invoiceDate: new Date('2026-05-15'),
        orderId: 'ORD-V1V2',
        recipientType: RecipientType.B2C,
        shipFromStateCode: '29',
        placeOfSupplyStateCode: '29',
        supplyType: SupplyType.INTRASTATE
      });

      // 1. Batch 1 Processing
      const batch1 = await batchRepo.createBatch(orgA, {
        batchNumber: 'BATCH-RUN-001',
        engineVersion: '0.1.0',
        rulesVersion: '2026.1',
        sourceFileIds: [file.id]
      });

      const resultV1 = await resultRepo.createInvoiceResult(orgA, {
        importBatchId: batch1.id,
        canonicalInvoiceId: canonical.invoice.id,
        sourceRecordId: record.id,
        totalTaxableValue: new Decimal('1000.00'),
        cgstAmount: new Decimal('90.00'),
        sgstAmount: new Decimal('90.00'),
        totalInvoiceAmount: new Decimal('1180.00'),
        primaryOutcome: PrimaryOutcome.VALID,
        lines: [
          {
            lineNumber: 1,
            sourceRecordId: record.id,
            sku: 'SKU-100',
            quantity: new Decimal('1.000'),
            itemTaxableValue: new Decimal('1000.00'),
            taxRate: new Decimal('0.1800'),
            cgstRate: new Decimal('0.0900'),
            cgstAmount: new Decimal('90.00'),
            sgstRate: new Decimal('0.0900'),
            sgstAmount: new Decimal('90.00'),
            totalLineAmount: new Decimal('1180.00')
          }
        ]
      });

      expect(resultV1.version).toBe(1);
      expect(resultV1.totalInvoiceAmount.equals(new Decimal('1180.00'))).toBe(true);

      // 2. Reject duplicate insertion in the exact same batch (Never silently upsert!)
      await expect(
        resultRepo.createInvoiceResult(orgA, {
          importBatchId: batch1.id,
          canonicalInvoiceId: canonical.invoice.id,
          sourceRecordId: record.id,
          totalTaxableValue: new Decimal('1000.00'),
          totalInvoiceAmount: new Decimal('1180.00'),
          primaryOutcome: PrimaryOutcome.VALID,
          lines: []
        })
      ).rejects.toThrow(DuplicateProcessingResultError);

      // 3. Complete Batch 1
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

      // 4. Batch 2 Reprocessing
      const batch2 = await batchRepo.createReprocessingBatch(orgA, {
        newBatchNumber: 'BATCH-RUN-002',
        parentBatchId: batch1.id,
        reprocessReason: 'Master data alignment',
        rulesVersion: '2026.2',
        sourceFileIds: [file.id]
      });

      const resultV2 = await resultRepo.createInvoiceResult(orgA, {
        importBatchId: batch2.id,
        canonicalInvoiceId: canonical.invoice.id,
        sourceRecordId: record.id,
        totalTaxableValue: new Decimal('1000.00'),
        cgstAmount: new Decimal('90.00'),
        sgstAmount: new Decimal('90.00'),
        totalInvoiceAmount: new Decimal('1180.00'),
        primaryOutcome: PrimaryOutcome.VALID,
        lines: [
          {
            lineNumber: 1,
            sourceRecordId: record.id,
            sku: 'SKU-100',
            quantity: new Decimal('1.000'),
            itemTaxableValue: new Decimal('1000.00'),
            taxRate: new Decimal('0.1800'),
            cgstRate: new Decimal('0.0900'),
            cgstAmount: new Decimal('90.00'),
            sgstRate: new Decimal('0.0900'),
            sgstAmount: new Decimal('90.00'),
            totalLineAmount: new Decimal('1180.00')
          }
        ]
      });

      expect(resultV2.version).toBe(2);
      expect(resultV2.importBatchId).toBe(batch2.id);

      // 5. Query both versions: both exist intact and frozen
      const allVersions = await resultRepo.findInvoiceResultsByCanonicalInvoice(
        orgA,
        canonical.invoice.id
      );
      expect(allVersions.length).toBe(2);
      expect(allVersions[0].version).toBe(1);
      expect(allVersions[0].importBatchId).toBe(batch1.id);
      expect(allVersions[1].version).toBe(2);
      expect(allVersions[1].importBatchId).toBe(batch2.id);
    });
  });

  // ==========================================
  // REQUIREMENT 5: MULTIPLE INVOICE LINES AND ORDERING
  // ==========================================
  describe('5. Multiple invoice lines and their ordering', () => {
    it('persists multiple lines and retrieves them strictly ordered by line_number ascending', async () => {
      const { file, record } = await setupSourceRecord(orgA, 'multilines');

      const canonical = await canonicalRepo.getOrCreateCanonicalInvoice(orgA, {
        sellerGstin: '29AAACA1234A1Z5',
        financialYear: '2026-2027',
        invoiceNumber: 'INV-MULTI-LINES-001',
        invoiceDate: new Date('2026-05-18'),
        orderId: 'ORD-MULTI-1',
        recipientType: RecipientType.B2B,
        shipFromStateCode: '29',
        placeOfSupplyStateCode: '27',
        supplyType: SupplyType.INTERSTATE
      });

      const batch = await batchRepo.createBatch(orgA, {
        batchNumber: 'BATCH-MULTI-LINES',
        engineVersion: '0.1.0',
        rulesVersion: '2026.1',
        sourceFileIds: [file.id]
      });

      // Pass lines deliberately out of order: 3, 1, 4, 2
      const result = await resultRepo.createInvoiceResult(orgA, {
        importBatchId: batch.id,
        canonicalInvoiceId: canonical.invoice.id,
        sourceRecordId: record.id,
        totalTaxableValue: new Decimal('4000.00'),
        igstAmount: new Decimal('720.00'),
        totalInvoiceAmount: new Decimal('4720.00'),
        primaryOutcome: PrimaryOutcome.VALID,
        lines: [
          {
            lineNumber: 3,
            sourceRecordId: record.id,
            sku: 'SKU-003',
            quantity: new Decimal('3.500'),
            unitPrice: new Decimal('285.7143'),
            itemTaxableValue: new Decimal('1000.00'),
            taxRate: new Decimal('0.1800'),
            igstRate: new Decimal('0.1800'),
            igstAmount: new Decimal('180.00'),
            totalLineAmount: new Decimal('1180.00')
          },
          {
            lineNumber: 1,
            sourceRecordId: record.id,
            sku: 'SKU-001',
            quantity: new Decimal('1.000'),
            unitPrice: new Decimal('1000.0000'),
            itemTaxableValue: new Decimal('1000.00'),
            taxRate: new Decimal('0.1800'),
            igstRate: new Decimal('0.1800'),
            igstAmount: new Decimal('180.00'),
            totalLineAmount: new Decimal('1180.00')
          },
          {
            lineNumber: 4,
            sourceRecordId: record.id,
            sku: 'SKU-004',
            quantity: new Decimal('2.000'),
            unitPrice: new Decimal('500.0000'),
            itemTaxableValue: new Decimal('1000.00'),
            taxRate: new Decimal('0.1800'),
            igstRate: new Decimal('0.1800'),
            igstAmount: new Decimal('180.00'),
            totalLineAmount: new Decimal('1180.00')
          },
          {
            lineNumber: 2,
            sourceRecordId: record.id,
            sku: 'SKU-002',
            quantity: new Decimal('4.000'),
            unitPrice: new Decimal('250.0000'),
            itemTaxableValue: new Decimal('1000.00'),
            taxRate: new Decimal('0.1800'),
            igstRate: new Decimal('0.1800'),
            igstAmount: new Decimal('180.00'),
            totalLineAmount: new Decimal('1180.00')
          }
        ]
      });

      expect(result.lines.length).toBe(4);
      // Verify strict line ordering 1, 2, 3, 4
      expect(result.lines[0].lineNumber).toBe(1);
      expect(result.lines[0].sku).toBe('SKU-001');
      expect(result.lines[1].lineNumber).toBe(2);
      expect(result.lines[1].sku).toBe('SKU-002');
      expect(result.lines[2].lineNumber).toBe(3);
      expect(result.lines[2].sku).toBe('SKU-003');
      expect(result.lines[3].lineNumber).toBe(4);
      expect(result.lines[3].sku).toBe('SKU-004');

      // Verify Decimal precision preservation
      expect(result.lines[2].quantity.equals(new Decimal('3.500'))).toBe(true);
      expect(result.lines[2].unitPrice?.equals(new Decimal('285.7143'))).toBe(true);
    });
  });

  // ==========================================
  // REQUIREMENT 6: CREDIT-NOTE PROCESSING RESULTS
  // ==========================================
  describe('6. Credit-note processing results', () => {
    it('persists credit note processing results with exact signed amounts and reversal state', async () => {
      const { file, record } = await setupSourceRecord(orgA, 'cn_res');

      const cn = await canonicalRepo.getOrCreateCanonicalCreditNote(orgA, {
        sellerGstin: '29AAACA1234A1Z5',
        financialYear: '2026-2027',
        creditNoteNumber: 'CN-FINANCIAL-001',
        creditNoteDate: new Date('2026-05-20'),
        originalInvoiceNumber: 'INV-ORIG-001',
        recipientType: RecipientType.B2C
      });

      const batch = await batchRepo.createBatch(orgA, {
        batchNumber: 'BATCH-CN-TEST',
        engineVersion: '0.1.0',
        rulesVersion: '2026.1',
        sourceFileIds: [file.id]
      });

      const cnResult = await resultRepo.createCreditNoteResult(orgA, {
        importBatchId: batch.id,
        canonicalCreditNoteId: cn.creditNote.id,
        sourceRecordId: record.id,
        taxableValueReversal: new Decimal('500.00'),
        cgstAmountReversal: new Decimal('45.00'),
        sgstAmountReversal: new Decimal('45.00'),
        creditNoteTotal: new Decimal('590.00'),
        rawSignedAmountText: '-590.00',
        signedAmount: new Decimal('-590.00'),
        reconciliationStatus: ReconciliationStatus.UNMATCHED_ORPHAN,
        primaryOutcome: PrimaryOutcome.VALID
      });

      expect(cnResult.id).toBeDefined();
      expect(cnResult.signedAmount.equals(new Decimal('-590.00'))).toBe(true);
      expect(cnResult.rawSignedAmountText).toBe('-590.00');
      expect(cnResult.reconciliationStatus).toBe(ReconciliationStatus.UNMATCHED_ORPHAN);

      // Verify lookup by batch and canonical ID
      const retrieved = await resultRepo.findCreditNoteResultByBatchAndCanonicalId(
        orgA,
        batch.id,
        cn.creditNote.id
      );
      expect(retrieved?.id).toBe(cnResult.id);
    });
  });

  // ==========================================
  // REQUIREMENT 7: STOCK-TRANSFER PROCESSING RESULTS
  // ==========================================
  describe('7. Stock-transfer processing results', () => {
    it('persists stock transfer processing results with classification and decimal values', async () => {
      const { file, record } = await setupSourceRecord(orgA, 'tr_res');

      const transfer = await canonicalRepo.getOrCreateCanonicalStockTransfer(orgA, {
        sourceGstin: '29AAACA1234A1Z5',
        financialYear: '2026-2027',
        transferInvoiceNumber: 'TR-STATUTORY-001',
        transferDate: new Date('2026-05-22'),
        destinationGstin: '27AAACA1234A1Z6',
        sourcePan: 'AAACA1234A',
        destinationPan: 'AAACA1234A',
        shipFromStateCode: '29',
        shipToStateCode: '27'
      });

      const batch = await batchRepo.createBatch(orgA, {
        batchNumber: 'BATCH-TR-TEST',
        engineVersion: '0.1.0',
        rulesVersion: '2026.1',
        sourceFileIds: [file.id]
      });

      const trResult = await resultRepo.createStockTransferResult(orgA, {
        importBatchId: batch.id,
        canonicalTransferId: transfer.transfer.id,
        sourceRecordId: record.id,
        classification: StockTransferClassification.DISTINCT_PERSON_SUPPLY,
        quantity: new Decimal('25.500'),
        taxableValue: new Decimal('12750.00'),
        igstAmount: new Decimal('2295.00'),
        totalInvoiceAmount: new Decimal('15045.00'),
        primaryOutcome: PrimaryOutcome.VALID
      });

      expect(trResult.id).toBeDefined();
      expect(trResult.classification).toBe(
        StockTransferClassification.DISTINCT_PERSON_SUPPLY
      );
      expect(trResult.quantity.equals(new Decimal('25.500'))).toBe(true);

      const retrieved = await resultRepo.findStockTransferResultById(orgA, trResult.id);
      expect(retrieved?.totalInvoiceAmount.equals(new Decimal('15045.00'))).toBe(true);
    });
  });

  // ==========================================
  // REQUIREMENT 8: CROSS-TENANT ACCESS REJECTION
  // ==========================================
  describe('8. Cross-tenant access rejection', () => {
    it('strictly denies cross-tenant access to canonical documents and results', async () => {
      const { file: fileB, record: recordB } = await setupSourceRecord(orgB, 'orgB_doc');

      const invB = await canonicalRepo.getOrCreateCanonicalInvoice(orgB, {
        sellerGstin: '29AAACB5678B1Z1',
        financialYear: '2026-2027',
        invoiceNumber: 'INV-TENANT-B-001',
        invoiceDate: new Date('2026-05-25'),
        orderId: 'ORD-B-1',
        recipientType: RecipientType.B2C,
        shipFromStateCode: '29',
        placeOfSupplyStateCode: '29',
        supplyType: SupplyType.INTRASTATE
      });

      const batchB = await batchRepo.createBatch(orgB, {
        batchNumber: 'BATCH-B-RESULTS',
        engineVersion: '0.1.0',
        rulesVersion: '2026.1',
        sourceFileIds: [fileB.id]
      });

      const resB = await resultRepo.createInvoiceResult(orgB, {
        importBatchId: batchB.id,
        canonicalInvoiceId: invB.invoice.id,
        sourceRecordId: recordB.id,
        totalTaxableValue: new Decimal('2000.00'),
        totalInvoiceAmount: new Decimal('2360.00'),
        primaryOutcome: PrimaryOutcome.VALID,
        lines: []
      });

      // Tenant A attempts to fetch Tenant B's canonical invoice -> returns null
      expect(await canonicalRepo.findCanonicalInvoiceById(orgA, invB.invoice.id)).toBeNull();

      // Tenant A attempts to fetch Tenant B's processing result -> returns null
      expect(await resultRepo.findInvoiceResultById(orgA, resB.id)).toBeNull();

      // Tenant A attempts to create result referencing Tenant B's canonical invoice -> throws
      const batchA = await batchRepo.createBatch(orgA, {
        batchNumber: 'BATCH-A-ATTEMPT-B',
        engineVersion: '0.1.0',
        rulesVersion: '2026.1'
      });

      const { record: recordA } = await setupSourceRecord(orgA, 'orgA_rec');
      await expect(
        resultRepo.createInvoiceResult(orgA, {
          importBatchId: batchA.id,
          canonicalInvoiceId: invB.invoice.id, // Tenant B document!
          sourceRecordId: recordA.id,
          totalTaxableValue: new Decimal('100.00'),
          totalInvoiceAmount: new Decimal('118.00'),
          primaryOutcome: PrimaryOutcome.VALID,
          lines: []
        })
      ).rejects.toThrow(CanonicalDocumentNotFoundError);
    });
  });

  // ==========================================
  // REQUIREMENT 9: TRANSACTION ROLLBACK
  // ==========================================
  describe('9. Transaction rollback', () => {
    it('aborts transaction cleanly without leaving orphaned canonical documents or results', async () => {
      const invNum = `INV-ROLLBACK-${Date.now()}`;

      await expect(
        runInTenantTransaction(prisma, orgA, async (tx) => {
          // 1. Create canonical invoice inside tx
          const inv = await canonicalRepo.getOrCreateCanonicalInvoice(
            orgA,
            {
              sellerGstin: '29AAACA1234A1Z5',
              financialYear: '2026-2027',
              invoiceNumber: invNum,
              invoiceDate: new Date('2026-05-25'),
              orderId: 'ORD-ROLLBACK',
              recipientType: RecipientType.B2C,
              shipFromStateCode: '29',
              placeOfSupplyStateCode: '29',
              supplyType: SupplyType.INTRASTATE
            },
            tx
          );

          expect(inv.invoice.id).toBeDefined();

          // 2. Deliberately throw an error to trigger ROLLBACK
          throw new Error('Simulated transaction abortion before commit');
        })
      ).rejects.toThrow('Simulated transaction abortion before commit');

      // Verify canonical invoice was NOT committed
      const check = await canonicalRepo.findCanonicalInvoice(
        orgA,
        '29AAACA1234A1Z5',
        '2026-2027',
        invNum
      );
      expect(check).toBeNull();
    });
  });

  // ==========================================
  // REQUIREMENT 10: CONCURRENT DUPLICATE CANONICAL INSERTION
  // ==========================================
  describe('10. Concurrent duplicate canonical document insertion', () => {
    it('handles parallel concurrent creations of identical canonical invoice returning same ID', async () => {
      const invNum = `INV-CONCUR-${Date.now()}`;
      const input = {
        sellerGstin: '29AAACA1234A1Z5',
        financialYear: '2026-2027',
        invoiceNumber: invNum,
        invoiceDate: new Date('2026-05-28'),
        orderId: 'ORD-CONCUR-DOC',
        recipientType: RecipientType.B2C,
        shipFromStateCode: '29',
        placeOfSupplyStateCode: '29',
        supplyType: SupplyType.INTRASTATE
      };

      // 3 workers attempt to get-or-create simultaneously
      const results = await Promise.all([
        canonicalRepo.getOrCreateCanonicalInvoice(orgA, input),
        canonicalRepo.getOrCreateCanonicalInvoice(orgA, input),
        canonicalRepo.getOrCreateCanonicalInvoice(orgA, input)
      ]);

      // All 3 must resolve successfully and return identical canonical invoice ID
      const firstId = results[0].invoice.id;
      expect(results[1].invoice.id).toBe(firstId);
      expect(results[2].invoice.id).toBe(firstId);

      // Verify exactly one row in PostgreSQL within tenant context
      const rows: any = await runInTenantTransaction(prisma, orgA, async (tx) => {
        return tx.$queryRaw`
          SELECT count(*)::int as count FROM canonical_invoices
          WHERE invoice_number = ${invNum};
        `;
      });
      expect(rows[0].count).toBe(1);
    });
  });

  // ==========================================
  // REQUIREMENT 11: REPROCESSING UNDER A DIFFERENT RULES_VERSION
  // ==========================================
  describe('11. Reprocessing under a different rules_version', () => {
    it('preserves distinct calculation results across rules versions for differential analysis', async () => {
      const { file, record } = await setupSourceRecord(orgA, 'tcs_diff');

      const canonical = await canonicalRepo.getOrCreateCanonicalInvoice(orgA, {
        sellerGstin: '29AAACA1234A1Z5',
        financialYear: '2026-2027',
        invoiceNumber: 'INV-TCS-DIFF-001',
        invoiceDate: new Date('2026-05-30'),
        orderId: 'ORD-TCS-DIFF',
        recipientType: RecipientType.B2C,
        shipFromStateCode: '29',
        placeOfSupplyStateCode: '29',
        supplyType: SupplyType.INTRASTATE
      });

      // 1. Batch 1 under Rules Version 2024.1 (1.0% TCS rate)
      const batch1 = await batchRepo.createBatch(orgA, {
        batchNumber: 'BATCH-RULES-2024-1',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1-1.0-TCS',
        sourceFileIds: [file.id]
      });

      const res1 = await resultRepo.createInvoiceResult(orgA, {
        importBatchId: batch1.id,
        canonicalInvoiceId: canonical.invoice.id,
        sourceRecordId: record.id,
        totalTaxableValue: new Decimal('10000.00'),
        totalInvoiceAmount: new Decimal('11800.00'),
        calculatedTcsCgst: new Decimal('50.00'), // 0.5% CGST
        calculatedTcsSgst: new Decimal('50.00'), // 0.5% SGST (Total 1.0%)
        primaryOutcome: PrimaryOutcome.VALID,
        lines: []
      });

      // 2. Batch 2 under Rules Version 2024.2 (Notification 15/2024 - 0.5% TCS rate)
      const batch2 = await batchRepo.createReprocessingBatch(orgA, {
        newBatchNumber: 'BATCH-RULES-2024-2',
        parentBatchId: batch1.id,
        reprocessReason: 'Statutory Section 52 TCS reduction to 0.5%',
        rulesVersion: '2024.2-0.5-TCS',
        sourceFileIds: [file.id]
      });

      const res2 = await resultRepo.createInvoiceResult(orgA, {
        importBatchId: batch2.id,
        canonicalInvoiceId: canonical.invoice.id,
        sourceRecordId: record.id,
        totalTaxableValue: new Decimal('10000.00'),
        totalInvoiceAmount: new Decimal('11800.00'),
        calculatedTcsCgst: new Decimal('25.00'), // 0.25% CGST
        calculatedTcsSgst: new Decimal('25.00'), // 0.25% SGST (Total 0.5%)
        primaryOutcome: PrimaryOutcome.VALID,
        lines: []
      });

      // 3. Verify differential calculations are preserved
      expect(res1.calculatedTcsCgst.equals(new Decimal('50.00'))).toBe(true);
      expect(res2.calculatedTcsCgst.equals(new Decimal('25.00'))).toBe(true);

      const varianceCgst = res1.calculatedTcsCgst.minus(res2.calculatedTcsCgst);
      expect(varianceCgst.equals(new Decimal('25.00'))).toBe(true); // ₹25 difference preserved for audit
    });
  });
});
