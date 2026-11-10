import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import {
  InMemorySourceRecordRepository,
  InMemoryImportBatchRepository,
  InMemoryCanonicalDocumentRepository,
  InMemoryProcessingResultRepository,
  TenantContext,
  RecordType,
  BatchStatus,
  FileBatchStatus,
  DuplicateSourceFileError,
  SourceFileNotFoundError,
  BatchNotFoundError,
  IllegalBatchStatusTransitionError,
  TenantAuthorizationError,
  DuplicateProcessingResultError,
  PrimaryOutcome
} from '../../src/repositories/index.js';
import {
  RecipientType,
  SupplyType,
  StockTransferClassification,
  ReconciliationStatus
} from '../../src/models/enums.js';
import { Decimal } from '../../src/utils/decimal.js';

describe('Phase 3B.3: InMemory Repositories Unit Suite', () => {
  let sourceRepo: InMemorySourceRecordRepository;
  let batchRepo: InMemoryImportBatchRepository;
  let canonicalRepo: InMemoryCanonicalDocumentRepository;
  let resultRepo: InMemoryProcessingResultRepository;

  const orgA: TenantContext = { organizationId: crypto.randomUUID() };
  const orgB: TenantContext = { organizationId: crypto.randomUUID() };

  beforeEach(() => {
    sourceRepo = new InMemorySourceRecordRepository();
    batchRepo = new InMemoryImportBatchRepository(sourceRepo);
    canonicalRepo = new InMemoryCanonicalDocumentRepository();
    resultRepo = new InMemoryProcessingResultRepository();
  });

  describe('SourceRecordRepository (In-Memory)', () => {
    it('creates and retrieves a new source file', async () => {
      const file = await sourceRepo.createSourceFile(orgA, {
        fileName: 'apr2026_mtr.csv',
        fileFingerprint: 'abc123hash',
        fileSizeBytes: 102400n,
        storageUri: 's3://bucket/apr2026_mtr.csv',
        reportPeriod: '2026-04',
        sourceReportType: 'AMAZON_MTR',
        totalPhysicalLines: 100
      });

      expect(file.id).toBeDefined();
      expect(file.organizationId).toBe(orgA.organizationId);
      expect(file.fileSizeBytes).toBe(102400n);

      const byId = await sourceRepo.findSourceFileById(orgA, file.id);
      expect(byId?.id).toBe(file.id);

      const byFp = await sourceRepo.findSourceFileByFingerprint(orgA, 'abc123hash');
      expect(byFp?.id).toBe(file.id);
    });

    it('rejects duplicate file fingerprint within same organization', async () => {
      await sourceRepo.createSourceFile(orgA, {
        fileName: 'file1.csv',
        fileFingerprint: 'dup_fingerprint',
        fileSizeBytes: 500n,
        storageUri: 's3://bucket/file1.csv',
        sourceReportType: 'AMAZON_MTR'
      });

      await expect(
        sourceRepo.createSourceFile(orgA, {
          fileName: 'file2.csv',
          fileFingerprint: 'dup_fingerprint',
          fileSizeBytes: 500n,
          storageUri: 's3://bucket/file2.csv',
          sourceReportType: 'AMAZON_MTR'
        })
      ).rejects.toThrow(DuplicateSourceFileError);
    });

    it('allows same fingerprint across different organizations (tenant isolation)', async () => {
      const fileA = await sourceRepo.createSourceFile(orgA, {
        fileName: 'fileA.csv',
        fileFingerprint: 'shared_fp',
        fileSizeBytes: 500n,
        storageUri: 's3://bucket/fileA.csv',
        sourceReportType: 'AMAZON_MTR'
      });

      const fileB = await sourceRepo.createSourceFile(orgB, {
        fileName: 'fileB.csv',
        fileFingerprint: 'shared_fp',
        fileSizeBytes: 500n,
        storageUri: 's3://bucket/fileB.csv',
        sourceReportType: 'AMAZON_MTR'
      });

      expect(fileA.id).not.toBe(fileB.id);
      expect(await sourceRepo.findSourceFileById(orgA, fileB.id)).toBeNull();
    });

    it('bulk inserts records and prevents duplicates on repeated upload', async () => {
      const file = await sourceRepo.createSourceFile(orgA, {
        fileName: 'records.csv',
        fileFingerprint: 'rec_fp',
        fileSizeBytes: 1000n,
        storageUri: 's3://bucket/records.csv',
        sourceReportType: 'AMAZON_MTR'
      });

      const records = [
        {
          physicalLineNumber: 2,
          logicalRecordNumber: 1,
          recordType: RecordType.OUTWARD_SUPPLY,
          rawPayload: { orderId: 'ORD-1', amount: 100 }
        },
        {
          physicalLineNumber: 3,
          logicalRecordNumber: 2,
          recordType: RecordType.CREDIT_NOTE,
          rawPayload: { orderId: 'ORD-2', amount: 50 }
        }
      ];

      const res1 = await sourceRepo.bulkInsertSourceRecords(orgA, file.id, records);
      expect(res1.insertedCount).toBe(2);
      expect(res1.skippedCount).toBe(0);

      // Repeated upload of the same physical lines
      const res2 = await sourceRepo.bulkInsertSourceRecords(orgA, file.id, records);
      expect(res2.insertedCount).toBe(0);
      expect(res2.skippedCount).toBe(2);

      const found = await sourceRepo.findRecordsBySourceFile(orgA, file.id);
      expect(found.length).toBe(2);
      expect(found[0].physicalLineNumber).toBe(2);
      expect(found[1].physicalLineNumber).toBe(3);
    });
  });

  describe('ImportBatchRepository (In-Memory)', () => {
    it('creates batch, associates source file and executes status lifecycle', async () => {
      const file = await sourceRepo.createSourceFile(orgA, {
        fileName: 'batch_file.csv',
        fileFingerprint: 'bf_fp',
        fileSizeBytes: 1000n,
        storageUri: 's3://bucket/batch_file.csv',
        sourceReportType: 'AMAZON_MTR'
      });

      const batch = await batchRepo.createBatch(orgA, {
        batchNumber: 'BATCH-2026-001',
        engineVersion: '1.0.0',
        rulesVersion: '2026.1',
        sourceFileIds: [file.id]
      });

      expect(batch.status).toBe(BatchStatus.PENDING);
      expect(batch.executionMode).toBe('STANDARD');

      const fullBatch = await batchRepo.getBatchById(orgA, batch.id);
      expect(fullBatch?.fileAssociations.length).toBe(1);
      expect(fullBatch?.fileAssociations[0].sourceFileId).toBe(file.id);

      // PENDING -> PROCESSING
      const processing = await batchRepo.updateBatchStatus(
        orgA,
        batch.id,
        BatchStatus.PENDING,
        BatchStatus.PROCESSING
      );
      expect(processing.status).toBe(BatchStatus.PROCESSING);

      // PROCESSING -> COMPLETED
      const completed = await batchRepo.updateBatchStatus(
        orgA,
        batch.id,
        BatchStatus.PROCESSING,
        BatchStatus.COMPLETED,
        { totalRecordsProcessed: 100 }
      );
      expect(completed.status).toBe(BatchStatus.COMPLETED);
      expect(completed.completedAt).toBeInstanceOf(Date);
      expect(completed.totalRecordsProcessed).toBe(100);

      // Illegal transition: COMPLETED -> PROCESSING should throw
      await expect(
        batchRepo.updateBatchStatus(
          orgA,
          batch.id,
          BatchStatus.COMPLETED,
          BatchStatus.PROCESSING
        )
      ).rejects.toThrow(IllegalBatchStatusTransitionError);
    });

    it('creates explicit reprocessing batch referencing existing source files', async () => {
      const file = await sourceRepo.createSourceFile(orgA, {
        fileName: 'reprocess.csv',
        fileFingerprint: 'rep_fp',
        fileSizeBytes: 1000n,
        storageUri: 's3://bucket/reprocess.csv',
        sourceReportType: 'AMAZON_MTR'
      });

      const parentBatch = await batchRepo.createBatch(orgA, {
        batchNumber: 'BATCH-ORIGINAL',
        engineVersion: '1.0.0',
        rulesVersion: '2026.1',
        sourceFileIds: [file.id]
      });

      await batchRepo.updateBatchStatus(
        orgA,
        parentBatch.id,
        BatchStatus.PENDING,
        BatchStatus.PROCESSING
      );
      await batchRepo.updateBatchStatus(
        orgA,
        parentBatch.id,
        BatchStatus.PROCESSING,
        BatchStatus.COMPLETED
      );

      // Create reprocessing batch with updated rules
      const reprocessBatch = await batchRepo.createReprocessingBatch(orgA, {
        newBatchNumber: 'BATCH-REPROCESS-001',
        parentBatchId: parentBatch.id,
        reprocessReason: 'Statutory TCS rate change under Notification 15/2024',
        rulesVersion: '2026.2',
        sourceFileIds: [file.id]
      });

      expect(reprocessBatch.executionMode).toBe('REPROCESSING');
      expect(reprocessBatch.parentBatchId).toBe(parentBatch.id);
      expect(reprocessBatch.rulesVersion).toBe('2026.2');
      expect(reprocessBatch.engineVersion).toBe('1.0.0');

      const reprocessFull = await batchRepo.getBatchById(orgA, reprocessBatch.id);
      expect(reprocessFull?.parentBatch?.id).toBe(parentBatch.id);
      expect(reprocessFull?.fileAssociations.length).toBe(1);
      expect(reprocessFull?.fileAssociations[0].sourceFileId).toBe(file.id);

      // Parent batch remains unchanged
      const parentUnchanged = await batchRepo.getBatchById(orgA, parentBatch.id);
      expect(parentUnchanged?.status).toBe(BatchStatus.COMPLETED);
    });

    it('rejects cross-tenant batch access and file association', async () => {
      const fileB = await sourceRepo.createSourceFile(orgB, {
        fileName: 'orgb_file.csv',
        fileFingerprint: 'orgb_fp',
        fileSizeBytes: 1000n,
        storageUri: 's3://bucket/orgb.csv',
        sourceReportType: 'AMAZON_MTR'
      });

      const batchA = await batchRepo.createBatch(orgA, {
        batchNumber: 'BATCH-A',
        engineVersion: '1.0.0',
        rulesVersion: '2026.1'
      });

      // Tenant A cannot retrieve Tenant B's file
      expect(await sourceRepo.findSourceFileById(orgA, fileB.id)).toBeNull();

      // Tenant A cannot associate Tenant B's file
      await expect(
        batchRepo.associateSourceFile(orgA, batchA.id, fileB.id)
      ).rejects.toThrow(SourceFileNotFoundError);

      // Tenant B cannot retrieve Tenant A's batch
      expect(await batchRepo.getBatchById(orgB, batchA.id)).toBeNull();
    });
  });

  describe('CanonicalDocumentRepository (In-Memory)', () => {
    it('manages canonical invoice lifecycle and guarantees idempotency', async () => {
      const input = {
        sellerGstin: '29AAACA1234A1Z5',
        financialYear: '2026-2027',
        invoiceNumber: 'INV-2026-001',
        invoiceDate: new Date('2026-05-10'),
        orderId: 'ORD-999',
        recipientType: RecipientType.B2C,
        shipFromStateCode: '29',
        placeOfSupplyStateCode: '29',
        supplyType: SupplyType.INTRASTATE
      };

      const res1 = await canonicalRepo.getOrCreateCanonicalInvoice(orgA, input);
      expect(res1.isNew).toBe(true);
      expect(res1.invoice.id).toBeDefined();

      // Repeated call returns existing
      const res2 = await canonicalRepo.getOrCreateCanonicalInvoice(orgA, input);
      expect(res2.isNew).toBe(false);
      expect(res2.invoice.id).toBe(res1.invoice.id);

      // Separate organization gets discrete canonical invoice
      const resB = await canonicalRepo.getOrCreateCanonicalInvoice(orgB, input);
      expect(resB.isNew).toBe(true);
      expect(resB.invoice.id).not.toBe(res1.invoice.id);
    });

    it('manages canonical credit notes and stock transfers', async () => {
      const cnRes = await canonicalRepo.getOrCreateCanonicalCreditNote(orgA, {
        sellerGstin: '29AAACA1234A1Z5',
        financialYear: '2026-2027',
        creditNoteNumber: 'CN-2026-001',
        creditNoteDate: new Date('2026-05-15'),
        originalInvoiceNumber: 'INV-2026-001',
        recipientType: RecipientType.B2C
      });
      expect(cnRes.isNew).toBe(true);

      const trRes = await canonicalRepo.getOrCreateCanonicalStockTransfer(orgA, {
        sourceGstin: '29AAACA1234A1Z5',
        financialYear: '2026-2027',
        transferInvoiceNumber: 'TR-2026-001',
        transferDate: new Date('2026-05-20'),
        destinationGstin: '27AAACA1234A1Z6',
        sourcePan: 'AAACA1234A',
        destinationPan: 'AAACA1234A',
        shipFromStateCode: '29',
        shipToStateCode: '27'
      });
      expect(trRes.isNew).toBe(true);
    });
  });

  describe('ProcessingResultRepository (In-Memory)', () => {
    it('creates versioned invoice results, preserves Decimal precision, and prohibits overwrite', async () => {
      const invRes = await canonicalRepo.getOrCreateCanonicalInvoice(orgA, {
        sellerGstin: '29AAACA1234A1Z5',
        financialYear: '2026-2027',
        invoiceNumber: 'INV-PRECISION-001',
        invoiceDate: new Date('2026-06-01'),
        orderId: 'ORD-777',
        recipientType: RecipientType.B2C,
        shipFromStateCode: '29',
        placeOfSupplyStateCode: '29',
        supplyType: SupplyType.INTRASTATE
      });

      const batch1Id = crypto.randomUUID();
      const sourceRecId = crypto.randomUUID();

      const res1 = await resultRepo.createInvoiceResult(orgA, {
        importBatchId: batch1Id,
        canonicalInvoiceId: invRes.invoice.id,
        sourceRecordId: sourceRecId,
        totalTaxableValue: new Decimal('1000.50'),
        cgstAmount: new Decimal('90.05'),
        sgstAmount: new Decimal('90.05'),
        totalInvoiceAmount: new Decimal('1180.60'),
        primaryOutcome: PrimaryOutcome.VALID,
        lines: [
          {
            lineNumber: 1,
            sourceRecordId: sourceRecId,
            sku: 'SKU-A',
            quantity: new Decimal('2.000'),
            itemTaxableValue: new Decimal('1000.50'),
            taxRate: new Decimal('0.1800'),
            cgstRate: new Decimal('0.0900'),
            cgstAmount: new Decimal('90.05'),
            sgstRate: new Decimal('0.0900'),
            sgstAmount: new Decimal('90.05'),
            totalLineAmount: new Decimal('1180.60')
          }
        ]
      });

      expect(res1.version).toBe(1);
      expect(res1.totalTaxableValue.equals(new Decimal('1000.50'))).toBe(true);
      expect(res1.lines[0].quantity.equals(new Decimal('2.000'))).toBe(true);

      // Attempting to insert duplicate result for same batch and invoice throws
      await expect(
        resultRepo.createInvoiceResult(orgA, {
          importBatchId: batch1Id,
          canonicalInvoiceId: invRes.invoice.id,
          sourceRecordId: sourceRecId,
          totalTaxableValue: new Decimal('1000.50'),
          totalInvoiceAmount: new Decimal('1180.60'),
          primaryOutcome: PrimaryOutcome.VALID,
          lines: []
        })
      ).rejects.toThrow(DuplicateProcessingResultError);

      // Reprocessing in Batch 2 creates version 2 without overwriting version 1
      const batch2Id = crypto.randomUUID();
      const res2 = await resultRepo.createInvoiceResult(orgA, {
        importBatchId: batch2Id,
        canonicalInvoiceId: invRes.invoice.id,
        sourceRecordId: sourceRecId,
        totalTaxableValue: new Decimal('1000.50'),
        totalInvoiceAmount: new Decimal('1180.60'),
        primaryOutcome: PrimaryOutcome.VALID,
        lines: []
      });

      expect(res2.version).toBe(2);
      expect(res2.importBatchId).toBe(batch2Id);

      // Both versions queryable
      const allVersions = await resultRepo.findInvoiceResultsByCanonicalInvoice(
        orgA,
        invRes.invoice.id
      );
      expect(allVersions.length).toBe(2);
      expect(allVersions[0].version).toBe(1);
      expect(allVersions[1].version).toBe(2);
    });

    it('creates credit note and stock transfer processing results', async () => {
      const cnRes = await canonicalRepo.getOrCreateCanonicalCreditNote(orgA, {
        sellerGstin: '29AAACA1234A1Z5',
        financialYear: '2026-2027',
        creditNoteNumber: 'CN-TEST-001',
        creditNoteDate: new Date('2026-06-05'),
        recipientType: RecipientType.B2C
      });

      const batchId = crypto.randomUUID();
      const sourceRecId = crypto.randomUUID();

      const cnResult = await resultRepo.createCreditNoteResult(orgA, {
        importBatchId: batchId,
        canonicalCreditNoteId: cnRes.creditNote.id,
        sourceRecordId: sourceRecId,
        taxableValueReversal: new Decimal('500.00'),
        creditNoteTotal: new Decimal('590.00'),
        rawSignedAmountText: '-590.00',
        signedAmount: new Decimal('-590.00'),
        primaryOutcome: PrimaryOutcome.VALID
      });

      expect(cnResult.id).toBeDefined();
      expect(cnResult.signedAmount.equals(new Decimal('-590.00'))).toBe(true);

      const trRes = await canonicalRepo.getOrCreateCanonicalStockTransfer(orgA, {
        sourceGstin: '29AAACA1234A1Z5',
        financialYear: '2026-2027',
        transferInvoiceNumber: 'TR-TEST-001',
        transferDate: new Date('2026-06-10'),
        destinationGstin: '27AAACA1234A1Z6',
        sourcePan: 'AAACA1234A',
        destinationPan: 'AAACA1234A',
        shipFromStateCode: '29',
        shipToStateCode: '27'
      });

      const trResult = await resultRepo.createStockTransferResult(orgA, {
        importBatchId: batchId,
        canonicalTransferId: trRes.transfer.id,
        sourceRecordId: sourceRecId,
        classification: StockTransferClassification.DISTINCT_PERSON_SUPPLY,
        quantity: new Decimal('10.000'),
        taxableValue: new Decimal('5000.00'),
        totalInvoiceAmount: new Decimal('5900.00'),
        primaryOutcome: PrimaryOutcome.VALID
      });

      expect(trResult.id).toBeDefined();
      expect(trResult.classification).toBe(
        StockTransferClassification.DISTINCT_PERSON_SUPPLY
      );
      expect(trResult.quantity.equals(new Decimal('10.000'))).toBe(true);
    });
  });
});
