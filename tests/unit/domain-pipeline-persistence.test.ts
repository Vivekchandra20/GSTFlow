import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import path from 'node:path';
import { Decimal } from '../../src/utils/decimal.js';
import {
  PersistentPipelineOrchestrator,
  RunPersistentBatchInput,
  ProcessingPersistenceService
} from '../../src/application/persistent-pipeline/index.js';
import {
  InMemoryImportBatchRepository,
  InMemorySourceRecordRepository,
  InMemoryCanonicalDocumentRepository,
  InMemoryProcessingResultRepository,
  InMemoryTransactionManager,
  TenantContext,
  BatchStatus,
  RecordType,
  PrimaryOutcome,
  FileBatchStatus
} from '../../src/repositories/index.js';
import { PipelineOrchestrator } from '../../src/pipeline/pipeline-orchestrator.js';
import { RecipientType, SupplyType, ReconciliationStatus } from '../../src/models/enums.js';

describe('Phase 3B.4.3: Domain Pipeline & Processing Result Persistence — Unit Test Suite', () => {
  let batchRepo: InMemoryImportBatchRepository;
  let sourceRepo: InMemorySourceRecordRepository;
  let canonicalRepo: InMemoryCanonicalDocumentRepository;
  let resultRepo: InMemoryProcessingResultRepository;
  let txManager: InMemoryTransactionManager;
  let orchestrator: PersistentPipelineOrchestrator;

  const validOrgId = 'a0000000-0000-4000-8000-000000000001';
  const tenantCtx: TenantContext = { organizationId: validOrgId };

  const b2bFilePath = path.resolve(
    __dirname,
    '../../GSTFlow_Synthetic_Test_Suite/amazon/synthetic_amazon_mtr_b2b.csv'
  );
  const creditNotesFilePath = path.resolve(
    __dirname,
    '../../GSTFlow_Synthetic_Test_Suite/amazon/synthetic_amazon_credit_notes.csv'
  );
  const stockTransfersFilePath = path.resolve(
    __dirname,
    '../../GSTFlow_Synthetic_Test_Suite/amazon/synthetic_amazon_stock_transfer.csv'
  );

  beforeEach(() => {
    batchRepo = new InMemoryImportBatchRepository();
    sourceRepo = new InMemorySourceRecordRepository();
    canonicalRepo = new InMemoryCanonicalDocumentRepository();
    resultRepo = new InMemoryProcessingResultRepository();
    txManager = new InMemoryTransactionManager();

    orchestrator = new PersistentPipelineOrchestrator({
      importBatchRepo: batchRepo,
      sourceRecordRepo: sourceRepo,
      canonicalDocRepo: canonicalRepo,
      processingResultRepo: resultRepo,
      transactionManager: txManager,
      persistenceChunkSize: 100
    });
  });

  describe('1. Detailed Domain Execution & Output Capture', () => {
    it('executes domain pipeline and captures structured invoices, credit notes, and transfers', async () => {
      const pipeline = new PipelineOrchestrator();
      const detailed = await pipeline.processBatchDetailed([b2bFilePath, creditNotesFilePath, stockTransfersFilePath]);

      expect(detailed.report).toBeDefined();
      expect(detailed.report.totalRecordsIngested).toBe(8000); // 5000 B2B + 2000 CN + 1000 Transfer
      expect(detailed.invoices.size).toBeGreaterThan(0);
      expect(detailed.creditNotes.length).toBe(2000);
      expect(detailed.stockTransfers.length).toBe(1000);

      // Verify invoice structure
      const firstInvoice = Array.from(detailed.invoices.values())[0];
      expect(firstInvoice.sellerGstin).toBeDefined();
      expect(firstInvoice.financialYear).toBe('2026-2027');
      expect(firstInvoice.invoiceNumber).toBeDefined();
      expect(firstInvoice.lines.length).toBeGreaterThanOrEqual(1);
      expect(firstInvoice.totalTaxableValue).toBeInstanceOf(Decimal);
      expect(firstInvoice.totalInvoiceAmount).toBeInstanceOf(Decimal);
      expect(firstInvoice.primaryOutcome).toBeDefined();
    });

    it('processBatch retains 100% backward compatibility returning summary ProcessingReport', async () => {
      const pipeline = new PipelineOrchestrator();
      const report = await pipeline.processBatch([b2bFilePath]);

      expect(report.totalRecordsIngested).toBe(5000);
      expect(report.outcomes.valid).toBe(5000);
      expect(report.zeroDataLossVerified).toBe(true);
    });
  });

  describe('2. Canonical Document Mapping & Conflict Detection', () => {
    it('maps invoices to canonical identities and reuses canonical documents across runs', async () => {
      const persistenceService = new ProcessingPersistenceService({
        canonicalDocRepo: canonicalRepo,
        processingResultRepo: resultRepo,
        transactionManager: txManager
      });

      const pipeline = new PipelineOrchestrator();
      const detailed = await pipeline.processBatchDetailed([b2bFilePath]);

      const batch1 = await batchRepo.createBatch(tenantCtx, {
        batchNumber: 'BATCH-MAP-001',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1'
      });

      const sourceFileMap = new Map();
      const res1 = await persistenceService.persistBatchResults(tenantCtx, batch1, detailed, sourceFileMap);

      expect(res1.invoicesPersisted).toBe(detailed.invoices.size);
      expect(res1.canonicalInvoicesCreated).toBe(detailed.invoices.size);

      // Persist under second batch (reprocessing)
      const batch2 = await batchRepo.createBatch(tenantCtx, {
        batchNumber: 'BATCH-MAP-002',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1'
      });

      const res2 = await persistenceService.persistBatchResults(tenantCtx, batch2, detailed, sourceFileMap);

      // Reused existing canonical invoices, so 0 new canonical documents created!
      expect(res2.canonicalInvoicesCreated).toBe(0);
      expect(res2.invoicesPersisted).toBe(detailed.invoices.size);
    });

    it('detects statutory identity attribute conflicts and flags outcome as REVIEW without mutating master', async () => {
      // Register canonical invoice with customer GSTIN A
      const initial = await canonicalRepo.getOrCreateCanonicalInvoice(tenantCtx, {
        sellerGstin: '29AAACA1234A1Z5',
        financialYear: '2026-2027',
        invoiceNumber: 'INV-CONFLICT-001',
        invoiceDate: new Date('2026-05-10'),
        orderId: 'ORD-1001',
        recipientType: RecipientType.B2B,
        customerGstin: '27AAACB5678B1Z2',
        shipFromStateCode: '29',
        placeOfSupplyStateCode: '27',
        supplyType: SupplyType.INTERSTATE
      });
      expect(initial.isNew).toBe(true);
      expect(initial.hasConflict).toBe(false);

      // Attempt second registration with contradictory customer GSTIN B
      const conflict = await canonicalRepo.getOrCreateCanonicalInvoice(tenantCtx, {
        sellerGstin: '29AAACA1234A1Z5',
        financialYear: '2026-2027',
        invoiceNumber: 'INV-CONFLICT-001',
        invoiceDate: new Date('2026-05-10'),
        orderId: 'ORD-1001',
        recipientType: RecipientType.B2B,
        customerGstin: '36AAACB9999C1Z9', // CONFLICTING GSTIN
        shipFromStateCode: '29',
        placeOfSupplyStateCode: '27',
        supplyType: SupplyType.INTERSTATE
      });

      expect(conflict.isNew).toBe(false);
      expect(conflict.hasConflict).toBe(true);
      expect(conflict.conflictDetails?.length).toBeGreaterThan(0);
      expect(conflict.conflictDetails?.[0].field).toBe('customerGstin');
      // Master document unchanged
      expect(conflict.invoice.customerGstin).toBe('27AAACB5678B1Z2');
    });
  });

  describe('3. Financial Precision & Decimal Preservation', () => {
    it('preserves exact Decimal values without IEEE 754 precision loss', async () => {
      const canonical = await canonicalRepo.getOrCreateCanonicalInvoice(tenantCtx, {
        sellerGstin: '29AAACA1234A1Z5',
        financialYear: '2026-2027',
        invoiceNumber: 'INV-DEC-PRECISION',
        invoiceDate: new Date('2026-06-15'),
        orderId: 'ORD-PRECISION',
        recipientType: RecipientType.B2B,
        customerGstin: '27AAACB5678B1Z2',
        shipFromStateCode: '29',
        placeOfSupplyStateCode: '27',
        supplyType: SupplyType.INTERSTATE
      });

      const batch = await batchRepo.createBatch(tenantCtx, {
        batchNumber: 'BATCH-PRECISION-001',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1'
      });

      const exactTaxable = new Decimal('1234567.89');
      const exactCgst = new Decimal('111111.11');
      const exactSgst = new Decimal('111111.11');
      const exactTotal = new Decimal('1456790.11');

      const result = await resultRepo.createInvoiceResult(tenantCtx, {
        importBatchId: batch.id,
        canonicalInvoiceId: canonical.invoice.id,
        sourceRecordId: crypto.randomUUID(),
        totalTaxableValue: exactTaxable,
        cgstAmount: exactCgst,
        sgstAmount: exactSgst,
        totalInvoiceAmount: exactTotal,
        primaryOutcome: PrimaryOutcome.VALID,
        lines: [
          {
            lineNumber: 1,
            sourceRecordId: crypto.randomUUID(),
            quantity: new Decimal('125.500'),
            unitPrice: new Decimal('9837.1943'),
            itemTaxableValue: exactTaxable,
            taxRate: new Decimal('18.0000'),
            cgstRate: new Decimal('9.0000'),
            cgstAmount: exactCgst,
            sgstRate: new Decimal('9.0000'),
            sgstAmount: exactSgst,
            totalLineAmount: exactTotal
          }
        ]
      });

      expect(result.totalTaxableValue.equals(exactTaxable)).toBe(true);
      expect(result.totalInvoiceAmount.equals(exactTotal)).toBe(true);
      expect(result.lines[0].quantity.equals(new Decimal('125.500'))).toBe(true);
      expect(result.lines[0].unitPrice?.equals(new Decimal('9837.1943'))).toBe(true);
      expect(result.lines[0].taxRate.equals(new Decimal('18.0000'))).toBe(true);
    });

    it('preserves signed financial conventions for credit notes', async () => {
      const canonical = await canonicalRepo.getOrCreateCanonicalCreditNote(tenantCtx, {
        sellerGstin: '29AAACA1234A1Z5',
        financialYear: '2026-2027',
        creditNoteNumber: 'CN-SIGNED-TEST',
        creditNoteDate: new Date('2026-07-20'),
        recipientType: RecipientType.B2C
      });

      const batch = await batchRepo.createBatch(tenantCtx, {
        batchNumber: 'BATCH-CN-SIGNED-001',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1'
      });

      const positiveTotal = new Decimal('590.00');
      const negativeSigned = positiveTotal.negated();

      const cnResult = await resultRepo.createCreditNoteResult(tenantCtx, {
        importBatchId: batch.id,
        canonicalCreditNoteId: canonical.creditNote.id,
        sourceRecordId: crypto.randomUUID(),
        taxableValueReversal: new Decimal('500.00'),
        creditNoteTotal: positiveTotal,
        rawSignedAmountText: negativeSigned.toFixed(2),
        signedAmount: negativeSigned,
        reconciliationStatus: ReconciliationStatus.UNMATCHED_ORPHAN,
        primaryOutcome: PrimaryOutcome.VALID
      });

      expect(cnResult.creditNoteTotal.equals(new Decimal('590.00'))).toBe(true);
      expect(cnResult.signedAmount.equals(new Decimal('-590.00'))).toBe(true);
      expect(cnResult.rawSignedAmountText).toBe('-590.00');
    });
  });

  describe('4. Historical Immutability & Reprocessing Versions', () => {
    it('creates versioned results on reprocessing without mutating historical results', async () => {
      const canonical = await canonicalRepo.getOrCreateCanonicalInvoice(tenantCtx, {
        sellerGstin: '29AAACA1234A1Z5',
        financialYear: '2026-2027',
        invoiceNumber: 'INV-VERSION-TEST',
        invoiceDate: new Date('2026-05-10'),
        orderId: 'ORD-V1',
        recipientType: RecipientType.B2B,
        customerGstin: '27AAACB5678B1Z2',
        shipFromStateCode: '29',
        placeOfSupplyStateCode: '27',
        supplyType: SupplyType.INTERSTATE
      });

      const batch1 = await batchRepo.createBatch(tenantCtx, {
        batchNumber: 'BATCH-RUN-1',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1'
      });

      // Run 1: Taxable 10,000
      const v1Result = await resultRepo.createInvoiceResult(tenantCtx, {
        importBatchId: batch1.id,
        canonicalInvoiceId: canonical.invoice.id,
        sourceRecordId: crypto.randomUUID(),
        totalTaxableValue: new Decimal('10000.00'),
        totalInvoiceAmount: new Decimal('11800.00'),
        primaryOutcome: PrimaryOutcome.VALID,
        lines: [
          {
            lineNumber: 1,
            sourceRecordId: crypto.randomUUID(),
            quantity: new Decimal('1'),
            itemTaxableValue: new Decimal('10000.00'),
            taxRate: new Decimal('18.0000'),
            totalLineAmount: new Decimal('11800.00')
          }
        ]
      });

      expect(v1Result.version).toBe(1);
      expect(v1Result.totalTaxableValue.equals(new Decimal('10000.00'))).toBe(true);

      // Run 2: Reprocessing in new batch with updated rules
      const batch2 = await batchRepo.createBatch(tenantCtx, {
        batchNumber: 'BATCH-RUN-2',
        engineVersion: '0.2.0',
        rulesVersion: '2025.1',
        parentBatchId: batch1.id
      });

      const v2Result = await resultRepo.createInvoiceResult(tenantCtx, {
        importBatchId: batch2.id,
        canonicalInvoiceId: canonical.invoice.id,
        sourceRecordId: crypto.randomUUID(),
        totalTaxableValue: new Decimal('10200.00'),
        totalInvoiceAmount: new Decimal('12036.00'),
        primaryOutcome: PrimaryOutcome.VALID,
        lines: [
          {
            lineNumber: 1,
            sourceRecordId: crypto.randomUUID(),
            quantity: new Decimal('1'),
            itemTaxableValue: new Decimal('10200.00'),
            taxRate: new Decimal('18.0000'),
            totalLineAmount: new Decimal('12036.00')
          }
        ]
      });

      expect(v2Result.version).toBe(2);
      expect(v2Result.totalTaxableValue.equals(new Decimal('10200.00'))).toBe(true);

      // Verify historical v1 remains completely frozen
      const historicalV1 = await resultRepo.findInvoiceResultByBatchAndCanonicalId(
        tenantCtx,
        batch1.id,
        canonical.invoice.id
      );
      expect(historicalV1?.version).toBe(1);
      expect(historicalV1?.totalTaxableValue.equals(new Decimal('10000.00'))).toBe(true);
    });

    it('rejects duplicate execution of the same canonical document in the same batch', async () => {
      const canonical = await canonicalRepo.getOrCreateCanonicalInvoice(tenantCtx, {
        sellerGstin: '29AAACA1234A1Z5',
        financialYear: '2026-2027',
        invoiceNumber: 'INV-DUP-TEST',
        invoiceDate: new Date('2026-05-10'),
        orderId: 'ORD-DUP',
        recipientType: RecipientType.B2B,
        customerGstin: '27AAACB5678B1Z2',
        shipFromStateCode: '29',
        placeOfSupplyStateCode: '27',
        supplyType: SupplyType.INTERSTATE
      });

      const batch = await batchRepo.createBatch(tenantCtx, {
        batchNumber: 'BATCH-DUP-001',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1'
      });

      await resultRepo.createInvoiceResult(tenantCtx, {
        importBatchId: batch.id,
        canonicalInvoiceId: canonical.invoice.id,
        sourceRecordId: crypto.randomUUID(),
        totalTaxableValue: new Decimal('1000.00'),
        totalInvoiceAmount: new Decimal('1180.00'),
        primaryOutcome: PrimaryOutcome.VALID,
        lines: []
      });

      // Second attempt in SAME batch must throw
      await expect(
        resultRepo.createInvoiceResult(tenantCtx, {
          importBatchId: batch.id,
          canonicalInvoiceId: canonical.invoice.id,
          sourceRecordId: crypto.randomUUID(),
          totalTaxableValue: new Decimal('1000.00'),
          totalInvoiceAmount: new Decimal('1180.00'),
          primaryOutcome: PrimaryOutcome.VALID,
          lines: []
        })
      ).rejects.toThrow();
    });
  });

  describe('5. Orchestrator Integration & Staging Invariants', () => {
    it('executes end-to-end runBatch with persistence and populates persistenceResult', async () => {
      const input: RunPersistentBatchInput = {
        batchNumber: 'BATCH-E2E-PERSIST-001',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1',
        filePaths: [b2bFilePath],
        persistProcessingResults: true,
        persistenceChunkSize: 500
      };

      const result = await orchestrator.runBatch(tenantCtx, input);

      expect(result.success).toBe(true);
      expect(result.batch.status).toBe(BatchStatus.COMPLETED);
      expect(result.persistenceResult).toBeDefined();
      expect(result.persistenceResult?.invoicesPersisted).toBeGreaterThan(0);
      expect(result.persistenceResult?.invoiceLinesPersisted).toBe(5000);
      expect(result.persistenceResult?.canonicalInvoicesCreated).toBeGreaterThan(0);
    });

    it('rejects domain execution if an associated source file is not completed', async () => {
      // Create source file and mark as FAILED
      const sf = await sourceRepo.createSourceFile(tenantCtx, {
        fileName: 'corrupted_file.csv',
        fileFingerprint: '0000000000000000000000000000000000000000000000000000000000000001',
        fileSizeBytes: 100,
        storageUri: '/tmp/corrupted.csv',
        sourceReportType: 'B2B'
      });

      const batch = await batchRepo.createBatch(tenantCtx, {
        batchNumber: 'BATCH-FAILED-SOURCE-001',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1'
      });

      await batchRepo.associateSourceFile(tenantCtx, batch.id, sf.id, FileBatchStatus.FAILED);

      const input: RunPersistentBatchInput = {
        batchNumber: 'BATCH-FAILED-SOURCE-001',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1',
        filePaths: [b2bFilePath]
      };

      await expect(orchestrator.runBatch(tenantCtx, input)).rejects.toThrow(
        /is not completed/
      );
    });
  });
});
