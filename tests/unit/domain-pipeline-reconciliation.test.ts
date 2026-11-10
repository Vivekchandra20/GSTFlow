import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { Decimal } from '../../src/utils/decimal.js';
import {
  PersistentPipelineOrchestrator,
  ProcessingPersistenceService
} from '../../src/application/persistent-pipeline/index.js';
import {
  InMemoryImportBatchRepository,
  InMemorySourceRecordRepository,
  InMemoryCanonicalDocumentRepository,
  InMemoryProcessingResultRepository,
  InMemoryReconciliationRepository,
  InMemoryTransactionManager,
  TenantContext,
  BatchStatus,
  RecordType,
  PrimaryOutcome,
  FileBatchStatus,
  CanonicalCreditNoteAlreadyReconciledError
} from '../../src/repositories/index.js';
import { PipelineOrchestrator } from '../../src/pipeline/pipeline-orchestrator.js';
import { RecipientType, SupplyType, ReconciliationStatus } from '../../src/models/enums.js';

describe('Phase 3B.4.4: Persistent Credit Note Reconciliation & Ledger Integration — Unit Suite', () => {
  let batchRepo: InMemoryImportBatchRepository;
  let sourceRepo: InMemorySourceRecordRepository;
  let canonicalRepo: InMemoryCanonicalDocumentRepository;
  let resultRepo: InMemoryProcessingResultRepository;
  let reconciliationRepo: InMemoryReconciliationRepository;
  let txManager: InMemoryTransactionManager;
  let orchestrator: PersistentPipelineOrchestrator;

  const validOrgId = 'a0000000-0000-4000-8000-000000000001';
  const tenantCtx: TenantContext = { organizationId: validOrgId };

  const creditNotesFilePath = path.resolve(
    __dirname,
    '../../GSTFlow_Synthetic_Test_Suite/amazon/synthetic_amazon_credit_notes.csv'
  );

  beforeEach(() => {
    batchRepo = new InMemoryImportBatchRepository();
    sourceRepo = new InMemorySourceRecordRepository();
    canonicalRepo = new InMemoryCanonicalDocumentRepository();
    resultRepo = new InMemoryProcessingResultRepository();
    reconciliationRepo = new InMemoryReconciliationRepository(resultRepo);
    txManager = new InMemoryTransactionManager();

    orchestrator = new PersistentPipelineOrchestrator({
      importBatchRepo: batchRepo,
      sourceRecordRepo: sourceRepo,
      canonicalDocRepo: canonicalRepo,
      processingResultRepo: resultRepo,
      reconciliationRepo,
      transactionManager: txManager,
      allowedUploadDir: path.resolve('.')
    });
  });

  it('1. Intra-batch Reconciliation: Persists reconciliation and updates invoice cumulative reversals', async () => {
    const persistenceService = new ProcessingPersistenceService({
      canonicalDocRepo: canonicalRepo,
      processingResultRepo: resultRepo,
      reconciliationRepo,
      transactionManager: txManager
    });

    const batch = await batchRepo.createBatch(tenantCtx, {
      batchNumber: 'BATCH-INTRA-REC-001',
      engineVersion: '0.1.0',
      rulesVersion: '2024.1'
    });

    // Mock detailed processing result with matching invoice and credit note
    const detailedResult: any = {
      invoices: new Map([
        [
          'INV-2026-001',
          {
            sellerGstin: '29AAACA1234A1Z5',
            financialYear: '2026-2027',
            invoiceNumber: 'INV-2026-001',
            invoiceDate: new Date('2026-05-01'),
            orderId: 'ORDER-001',
            recipientType: RecipientType.B2C,
            customerGstin: null,
            shipFromStateCode: '29',
            placeOfSupplyStateCode: '29',
            supplyType: SupplyType.INTRASTATE,
            totalTaxableValue: new Decimal('10000.00'),
            shippingTaxableValue: new Decimal('0.00'),
            cgstAmount: new Decimal('900.00'),
            sgstAmount: new Decimal('900.00'),
            utgstAmount: new Decimal('0.00'),
            igstAmount: new Decimal('0.00'),
            cessAmount: new Decimal('0.00'),
            totalInvoiceAmount: new Decimal('11800.00'),
            primaryOutcome: PrimaryOutcome.VALID,
            lines: []
          }
        ]
      ]),
      creditNotes: [
        {
          record: {
            sellerGstin: '29AAACA1234A1Z5',
            financialYear: '2026-2027',
            creditNoteNumber: 'CN-2026-001',
            creditNoteDate: new Date('2026-05-15'),
            originalInvoiceNumber: 'INV-2026-001',
            originalInvoiceDate: new Date('2026-05-01'),
            orderId: 'ORDER-001',
            recipientType: RecipientType.B2C,
            customerGstin: null,
            placeOfSupplyStateCode: '29',
            taxableValueReversal: new Decimal('2000.00'),
            cgstAmountReversal: new Decimal('180.00'),
            sgstAmountReversal: new Decimal('180.00'),
            utgstAmountReversal: new Decimal('0.00'),
            igstAmountReversal: new Decimal('0.00'),
            creditNoteTotal: new Decimal('2360.00'),
            reconciliationStatus: ReconciliationStatus.MATCHED_PARTIAL,
            matchedInvoiceNumber: 'INV-2026-001',
            sourceRef: {
              sourceRowNumber: 10,
              physicalLineNumber: 10,
              sourceReport: 'CREDIT_NOTE',
              rawRecord: {}
            }
          },
          filePath: 'mock_cn.csv',
          primaryOutcome: PrimaryOutcome.VALID
        }
      ],
      stockTransfers: [],
      cancelledOrders: [],
      malformedRecords: [],
      report: {} as any
    };

    const persistResult = await persistenceService.persistBatchResults(
      tenantCtx,
      batch,
      detailedResult,
      new Map()
    );

    expect(persistResult.invoicesPersisted).toBe(1);
    expect(persistResult.creditNotesPersisted).toBe(1);
    expect(persistResult.reconciliationsCreated).toBe(1);
    expect(persistResult.cumulativeReversalsApplied).toBe(1);

    // Verify invoice result cumulative reversals in repository
    const invCanonical = await canonicalRepo.findCanonicalInvoice(
      tenantCtx,
      '29AAACA1234A1Z5',
      '2026-2027',
      'INV-2026-001'
    );
    expect(invCanonical).not.toBeNull();

    const invResults = await resultRepo.findInvoiceResultsByCanonicalInvoice(
      tenantCtx,
      invCanonical!.id
    );
    expect(invResults.length).toBe(1);
    expect(invResults[0].cumulativeTaxableReversed.toString()).toBe('2000');
    expect(invResults[0].cumulativeTotalReversed.toString()).toBe('2360');
    expect(invResults[0].reversalCount).toBe(1);
  });

  it('2. Cross-batch Reconciliation: Matches credit note against prior batch invoice result', async () => {
    const persistenceService = new ProcessingPersistenceService({
      canonicalDocRepo: canonicalRepo,
      processingResultRepo: resultRepo,
      reconciliationRepo,
      transactionManager: txManager
    });

    // Batch 1: Ingests Outward Invoice
    const batch1 = await batchRepo.createBatch(tenantCtx, {
      batchNumber: 'BATCH-CROSS-001',
      engineVersion: '0.1.0',
      rulesVersion: '2024.1'
    });

    const invCanonical = await canonicalRepo.getOrCreateCanonicalInvoice(tenantCtx, {
      sellerGstin: '27AABCT1234T1Z2',
      financialYear: '2026-2027',
      invoiceNumber: 'INV-PRIOR-999',
      invoiceDate: new Date('2026-04-10'),
      orderId: 'ORD-PRIOR-999',
      recipientType: RecipientType.B2B,
      customerGstin: '27AABCB9999B1Z1',
      shipFromStateCode: '27',
      placeOfSupplyStateCode: '27',
      supplyType: SupplyType.INTRASTATE
    });

    const invResult = await resultRepo.createInvoiceResult(tenantCtx, {
      importBatchId: batch1.id,
      canonicalInvoiceId: invCanonical.invoice.id,
      sourceRecordId: crypto.randomUUID(),
      totalTaxableValue: new Decimal('50000.00'),
      cgstAmount: new Decimal('4500.00'),
      sgstAmount: new Decimal('4500.00'),
      totalInvoiceAmount: new Decimal('59000.00'),
      primaryOutcome: PrimaryOutcome.VALID,
      lines: []
    });

    // Batch 2: Ingests Credit Note referencing INV-PRIOR-999
    const batch2 = await batchRepo.createBatch(tenantCtx, {
      batchNumber: 'BATCH-CROSS-002',
      engineVersion: '0.1.0',
      rulesVersion: '2024.1'
    });

    const detailedBatch2: any = {
      invoices: new Map(),
      creditNotes: [
        {
          record: {
            sellerGstin: '27AABCT1234T1Z2',
            financialYear: '2026-2027',
            creditNoteNumber: 'CN-CROSS-999',
            creditNoteDate: new Date('2026-04-25'),
            originalInvoiceNumber: 'INV-PRIOR-999',
            originalInvoiceDate: new Date('2026-04-10'),
            orderId: 'ORD-PRIOR-999',
            recipientType: RecipientType.B2B,
            customerGstin: '27AABCB9999B1Z1',
            placeOfSupplyStateCode: '27',
            taxableValueReversal: new Decimal('5000.00'),
            cgstAmountReversal: new Decimal('450.00'),
            sgstAmountReversal: new Decimal('450.00'),
            utgstAmountReversal: new Decimal('0.00'),
            igstAmountReversal: new Decimal('0.00'),
            creditNoteTotal: new Decimal('5900.00'),
            reconciliationStatus: ReconciliationStatus.MATCHED_FULL,
            matchedInvoiceNumber: 'INV-PRIOR-999',
            sourceRef: {
              sourceRowNumber: 5,
              physicalLineNumber: 5,
              sourceReport: 'CREDIT_NOTE',
              rawRecord: {}
            }
          },
          filePath: 'mock_cn_batch2.csv',
          primaryOutcome: PrimaryOutcome.VALID
        }
      ],
      stockTransfers: [],
      cancelledOrders: [],
      malformedRecords: [],
      report: {} as any
    };

    const persistResult2 = await persistenceService.persistBatchResults(
      tenantCtx,
      batch2,
      detailedBatch2,
      new Map()
    );

    expect(persistResult2.creditNotesPersisted).toBe(1);
    expect(persistResult2.reconciliationsCreated).toBe(1);
    expect(persistResult2.cumulativeReversalsApplied).toBe(1);

    // Verify Batch 1's invoice result received cumulative updates
    const updatedInv = await resultRepo.findInvoiceResultById(tenantCtx, invResult.id);
    expect(updatedInv?.cumulativeTaxableReversed.toString()).toBe('5000');
    expect(updatedInv?.cumulativeTotalReversed.toString()).toBe('5900');
    expect(updatedInv?.reversalCount).toBe(1);
  });

  it('3. Double-Reconciliation Prevention: Rejects double application across reprocessed batches without supersession', async () => {
    const persistenceService = new ProcessingPersistenceService({
      canonicalDocRepo: canonicalRepo,
      processingResultRepo: resultRepo,
      reconciliationRepo,
      transactionManager: txManager
    });

    const batch1 = await batchRepo.createBatch(tenantCtx, {
      batchNumber: 'BATCH-DOUBLE-001',
      engineVersion: '0.1.0',
      rulesVersion: '2024.1'
    });

    const detailedBatch: any = {
      invoices: new Map([
        [
          'INV-DUP-001',
          {
            sellerGstin: '29AAACA1234A1Z5',
            financialYear: '2026-2027',
            invoiceNumber: 'INV-DUP-001',
            invoiceDate: new Date('2026-05-01'),
            orderId: 'ORDER-DUP',
            recipientType: RecipientType.B2C,
            customerGstin: null,
            shipFromStateCode: '29',
            placeOfSupplyStateCode: '29',
            supplyType: SupplyType.INTRASTATE,
            totalTaxableValue: new Decimal('10000.00'),
            shippingTaxableValue: new Decimal('0.00'),
            cgstAmount: new Decimal('900.00'),
            sgstAmount: new Decimal('900.00'),
            utgstAmount: new Decimal('0.00'),
            igstAmount: new Decimal('0.00'),
            cessAmount: new Decimal('0.00'),
            totalInvoiceAmount: new Decimal('11800.00'),
            primaryOutcome: PrimaryOutcome.VALID,
            lines: []
          }
        ]
      ]),
      creditNotes: [
        {
          record: {
            sellerGstin: '29AAACA1234A1Z5',
            financialYear: '2026-2027',
            creditNoteNumber: 'CN-DUP-001',
            creditNoteDate: new Date('2026-05-15'),
            originalInvoiceNumber: 'INV-DUP-001',
            originalInvoiceDate: new Date('2026-05-01'),
            orderId: 'ORDER-DUP',
            recipientType: RecipientType.B2C,
            customerGstin: null,
            placeOfSupplyStateCode: '29',
            taxableValueReversal: new Decimal('2000.00'),
            cgstAmountReversal: new Decimal('180.00'),
            sgstAmountReversal: new Decimal('180.00'),
            utgstAmountReversal: new Decimal('0.00'),
            igstAmountReversal: new Decimal('0.00'),
            creditNoteTotal: new Decimal('2360.00'),
            reconciliationStatus: ReconciliationStatus.MATCHED_PARTIAL,
            matchedInvoiceNumber: 'INV-DUP-001',
            sourceRef: {
              sourceRowNumber: 10,
              physicalLineNumber: 10,
              sourceReport: 'CREDIT_NOTE',
              rawRecord: {}
            }
          },
          filePath: 'mock_cn.csv',
          primaryOutcome: PrimaryOutcome.VALID
        }
      ],
      stockTransfers: [],
      cancelledOrders: [],
      malformedRecords: [],
      report: {} as any
    };

    // Run Batch 1: successfully creates reconciliation
    await persistenceService.persistBatchResults(tenantCtx, batch1, detailedBatch, new Map());

    // Batch 2 in STANDARD mode (not REPROCESSING) attempts to reconcile the same credit note again
    const batch2 = await batchRepo.createBatch(tenantCtx, {
      batchNumber: 'BATCH-DOUBLE-002',
      engineVersion: '0.1.0',
      rulesVersion: '2024.1',
      executionMode: 'STANDARD'
    });

    await expect(
      persistenceService.persistBatchResults(tenantCtx, batch2, detailedBatch, new Map())
    ).rejects.toThrow(CanonicalCreditNoteAlreadyReconciledError);
  });

  it('4. Reprocessing Supersession: Reprocessing batch supersedes prior reconciliation without duplicating financial reversal', async () => {
    const persistenceService = new ProcessingPersistenceService({
      canonicalDocRepo: canonicalRepo,
      processingResultRepo: resultRepo,
      reconciliationRepo,
      transactionManager: txManager
    });

    const batch1 = await batchRepo.createBatch(tenantCtx, {
      batchNumber: 'BATCH-SUPER-001',
      engineVersion: '0.1.0',
      rulesVersion: '2024.1'
    });

    const detailedBatch: any = {
      invoices: new Map([
        [
          'INV-SUPER-001',
          {
            sellerGstin: '29AAACA1234A1Z5',
            financialYear: '2026-2027',
            invoiceNumber: 'INV-SUPER-001',
            invoiceDate: new Date('2026-05-01'),
            orderId: 'ORDER-SUPER',
            recipientType: RecipientType.B2C,
            customerGstin: null,
            shipFromStateCode: '29',
            placeOfSupplyStateCode: '29',
            supplyType: SupplyType.INTRASTATE,
            totalTaxableValue: new Decimal('10000.00'),
            shippingTaxableValue: new Decimal('0.00'),
            cgstAmount: new Decimal('900.00'),
            sgstAmount: new Decimal('900.00'),
            utgstAmount: new Decimal('0.00'),
            igstAmount: new Decimal('0.00'),
            cessAmount: new Decimal('0.00'),
            totalInvoiceAmount: new Decimal('11800.00'),
            primaryOutcome: PrimaryOutcome.VALID,
            lines: []
          }
        ]
      ]),
      creditNotes: [
        {
          record: {
            sellerGstin: '29AAACA1234A1Z5',
            financialYear: '2026-2027',
            creditNoteNumber: 'CN-SUPER-001',
            creditNoteDate: new Date('2026-05-15'),
            originalInvoiceNumber: 'INV-SUPER-001',
            originalInvoiceDate: new Date('2026-05-01'),
            orderId: 'ORDER-SUPER',
            recipientType: RecipientType.B2C,
            customerGstin: null,
            placeOfSupplyStateCode: '29',
            taxableValueReversal: new Decimal('2500.00'),
            cgstAmountReversal: new Decimal('225.00'),
            sgstAmountReversal: new Decimal('225.00'),
            utgstAmountReversal: new Decimal('0.00'),
            igstAmountReversal: new Decimal('0.00'),
            creditNoteTotal: new Decimal('2950.00'),
            reconciliationStatus: ReconciliationStatus.MATCHED_PARTIAL,
            matchedInvoiceNumber: 'INV-SUPER-001',
            sourceRef: {
              sourceRowNumber: 10,
              physicalLineNumber: 10,
              sourceReport: 'CREDIT_NOTE',
              rawRecord: {}
            }
          },
          filePath: 'mock_cn.csv',
          primaryOutcome: PrimaryOutcome.VALID
        }
      ],
      stockTransfers: [],
      cancelledOrders: [],
      malformedRecords: [],
      report: {} as any
    };

    // Run Batch 1
    const res1 = await persistenceService.persistBatchResults(tenantCtx, batch1, detailedBatch, new Map());
    expect(res1.reconciliationsCreated).toBe(1);
    expect(res1.cumulativeReversalsApplied).toBe(1);

    // Batch 2 in REPROCESSING mode
    const batch2 = await batchRepo.createReprocessingBatch(tenantCtx, {
      newBatchNumber: 'BATCH-SUPER-002',
      parentBatchId: batch1.id,
      reprocessReason: 'Statutory rules reprocessing',
      rulesVersion: '2025.1',
      sourceFileIds: []
    });

    const res2 = await persistenceService.persistBatchResults(tenantCtx, batch2, detailedBatch, new Map());
    expect(res2.reconciliationsCreated).toBe(0);
    expect(res2.reconciliationsSuperseded).toBe(1);
    expect(res2.cumulativeReversalsApplied).toBe(0); // Did not double-apply reversal!

    // Verify invoice cumulative reversal remains ₹2500 (not ₹5000)
    const invCanonical = await canonicalRepo.findCanonicalInvoice(
      tenantCtx,
      '29AAACA1234A1Z5',
      '2026-2027',
      'INV-SUPER-001'
    );
    const invResults = await resultRepo.findInvoiceResultsByCanonicalInvoice(
      tenantCtx,
      invCanonical!.id
    );

    // Version 1 has 2500 reversal
    expect(invResults[0].cumulativeTaxableReversed.toString()).toBe('2500');
    expect(invResults[0].reversalCount).toBe(1);
  });

  it('5. Multiple Credit Notes Against Single Invoice: Accumulates reversals correctly', async () => {
    const persistenceService = new ProcessingPersistenceService({
      canonicalDocRepo: canonicalRepo,
      processingResultRepo: resultRepo,
      reconciliationRepo,
      transactionManager: txManager
    });

    const batch = await batchRepo.createBatch(tenantCtx, {
      batchNumber: 'BATCH-MULTI-CN-001',
      engineVersion: '0.1.0',
      rulesVersion: '2024.1'
    });

    const detailedBatch: any = {
      invoices: new Map([
        [
          'INV-MULTI-001',
          {
            sellerGstin: '29AAACA1234A1Z5',
            financialYear: '2026-2027',
            invoiceNumber: 'INV-MULTI-001',
            invoiceDate: new Date('2026-05-01'),
            orderId: 'ORDER-MULTI',
            recipientType: RecipientType.B2C,
            customerGstin: null,
            shipFromStateCode: '29',
            placeOfSupplyStateCode: '29',
            supplyType: SupplyType.INTRASTATE,
            totalTaxableValue: new Decimal('20000.00'),
            shippingTaxableValue: new Decimal('0.00'),
            cgstAmount: new Decimal('1800.00'),
            sgstAmount: new Decimal('1800.00'),
            utgstAmount: new Decimal('0.00'),
            igstAmount: new Decimal('0.00'),
            cessAmount: new Decimal('0.00'),
            totalInvoiceAmount: new Decimal('23600.00'),
            primaryOutcome: PrimaryOutcome.VALID,
            lines: []
          }
        ]
      ]),
      creditNotes: [
        {
          record: {
            sellerGstin: '29AAACA1234A1Z5',
            financialYear: '2026-2027',
            creditNoteNumber: 'CN-MULTI-A',
            creditNoteDate: new Date('2026-05-10'),
            originalInvoiceNumber: 'INV-MULTI-001',
            originalInvoiceDate: new Date('2026-05-01'),
            orderId: 'ORDER-MULTI',
            recipientType: RecipientType.B2C,
            customerGstin: null,
            placeOfSupplyStateCode: '29',
            taxableValueReversal: new Decimal('3000.00'),
            cgstAmountReversal: new Decimal('270.00'),
            sgstAmountReversal: new Decimal('270.00'),
            utgstAmountReversal: new Decimal('0.00'),
            igstAmountReversal: new Decimal('0.00'),
            creditNoteTotal: new Decimal('3540.00'),
            reconciliationStatus: ReconciliationStatus.MATCHED_PARTIAL,
            matchedInvoiceNumber: 'INV-MULTI-001',
            sourceRef: { sourceRowNumber: 1, physicalLineNumber: 1, sourceReport: 'CREDIT_NOTE', rawRecord: {} }
          },
          filePath: 'mock_cn.csv',
          primaryOutcome: PrimaryOutcome.VALID
        },
        {
          record: {
            sellerGstin: '29AAACA1234A1Z5',
            financialYear: '2026-2027',
            creditNoteNumber: 'CN-MULTI-B',
            creditNoteDate: new Date('2026-05-12'),
            originalInvoiceNumber: 'INV-MULTI-001',
            originalInvoiceDate: new Date('2026-05-01'),
            orderId: 'ORDER-MULTI',
            recipientType: RecipientType.B2C,
            customerGstin: null,
            placeOfSupplyStateCode: '29',
            taxableValueReversal: new Decimal('4000.00'),
            cgstAmountReversal: new Decimal('360.00'),
            sgstAmountReversal: new Decimal('360.00'),
            utgstAmountReversal: new Decimal('0.00'),
            igstAmountReversal: new Decimal('0.00'),
            creditNoteTotal: new Decimal('4720.00'),
            reconciliationStatus: ReconciliationStatus.MATCHED_PARTIAL,
            matchedInvoiceNumber: 'INV-MULTI-001',
            sourceRef: { sourceRowNumber: 2, physicalLineNumber: 2, sourceReport: 'CREDIT_NOTE', rawRecord: {} }
          },
          filePath: 'mock_cn.csv',
          primaryOutcome: PrimaryOutcome.VALID
        }
      ],
      stockTransfers: [],
      cancelledOrders: [],
      malformedRecords: [],
      report: {} as any
    };

    const res = await persistenceService.persistBatchResults(tenantCtx, batch, detailedBatch, new Map());
    expect(res.reconciliationsCreated).toBe(2);
    expect(res.cumulativeReversalsApplied).toBe(2);

    const invCanonical = await canonicalRepo.findCanonicalInvoice(
      tenantCtx,
      '29AAACA1234A1Z5',
      '2026-2027',
      'INV-MULTI-001'
    );
    const invResults = await resultRepo.findInvoiceResultsByCanonicalInvoice(
      tenantCtx,
      invCanonical!.id
    );

    // Total reversed: 3000 + 4000 = 7000
    expect(invResults[0].cumulativeTaxableReversed.toString()).toBe('7000');
    // Total gross reversed: 3540 + 4720 = 8260
    expect(invResults[0].cumulativeTotalReversed.toString()).toBe('8260');
    expect(invResults[0].reversalCount).toBe(2);
  });

  it('6. Orphan Credit Note: Persists credit note without creating reconciliation', async () => {
    const persistenceService = new ProcessingPersistenceService({
      canonicalDocRepo: canonicalRepo,
      processingResultRepo: resultRepo,
      reconciliationRepo,
      transactionManager: txManager
    });

    const batch = await batchRepo.createBatch(tenantCtx, {
      batchNumber: 'BATCH-ORPHAN-001',
      engineVersion: '0.1.0',
      rulesVersion: '2024.1'
    });

    const detailedBatch: any = {
      invoices: new Map(),
      creditNotes: [
        {
          record: {
            sellerGstin: '29AAACA1234A1Z5',
            financialYear: '2026-2027',
            creditNoteNumber: 'CN-ORPHAN-001',
            creditNoteDate: new Date('2026-05-15'),
            originalInvoiceNumber: 'NON-EXISTENT-INV',
            originalInvoiceDate: new Date('2026-05-01'),
            orderId: 'ORDER-ORPHAN',
            recipientType: RecipientType.B2C,
            customerGstin: null,
            placeOfSupplyStateCode: '29',
            taxableValueReversal: new Decimal('1000.00'),
            cgstAmountReversal: new Decimal('90.00'),
            sgstAmountReversal: new Decimal('90.00'),
            utgstAmountReversal: new Decimal('0.00'),
            igstAmountReversal: new Decimal('0.00'),
            creditNoteTotal: new Decimal('1180.00'),
            reconciliationStatus: ReconciliationStatus.UNMATCHED_ORPHAN,
            matchedInvoiceNumber: null,
            sourceRef: { sourceRowNumber: 1, physicalLineNumber: 1, sourceReport: 'CREDIT_NOTE', rawRecord: {} }
          },
          filePath: 'mock_cn.csv',
          primaryOutcome: PrimaryOutcome.VALID
        }
      ],
      stockTransfers: [],
      cancelledOrders: [],
      malformedRecords: [],
      report: {} as any
    };

    const res = await persistenceService.persistBatchResults(tenantCtx, batch, detailedBatch, new Map());
    expect(res.creditNotesPersisted).toBe(1);
    expect(res.reconciliationsCreated).toBe(0);
    expect(res.cumulativeReversalsApplied).toBe(0);

    const cnCanonical = await canonicalRepo.findCanonicalCreditNote(
      tenantCtx,
      '29AAACA1234A1Z5',
      '2026-2027',
      'CN-ORPHAN-001'
    );
    expect(cnCanonical).not.toBeNull();
  });
});
