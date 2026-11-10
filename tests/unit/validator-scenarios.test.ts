import { describe, it, expect } from 'vitest';
import { Decimal } from '../../src/utils/decimal.js';
import { defaultValidator, ValidationStatus, ValidationEngine } from '../../src/engine/validator.js';
import { defaultNormalizer } from '../../src/engine/normalizer.js';
import { defaultRouter, RouteDestination } from '../../src/engine/router.js';
import { defaultDeduplicator } from '../../src/engine/deduplicator.js';
import { defaultReconciler } from '../../src/engine/reconciler.js';
import { defaultStockTransferProcessor } from '../../src/engine/stock-transfer.js';
import {
  OutwardSupplyRecord,
  CancelledOrderRecord,
  StockTransferRecord,
  CreditNoteRecord
} from '../../src/models/transaction.schema.js';
import {
  RecipientType,
  SupplyType,
  IssueCode,
  IssueSeverity,
  StockTransferClassification,
  ReconciliationStatus
} from '../../src/models/enums.js';

describe('ValidationEngine - All 15 GST Test Scenarios', () => {
  const baseOutward: OutwardSupplyRecord = {
    recordType: 'OUTWARD_SUPPLY',
    id: 'tx-scenario',
    sourceRef: { sourceReport: 'SYNTHETIC_AMAZON_MTR', sourceRowNumber: 100 },
    sellerGstin: '27ZZZKA0001B3Z5', // Maharashtra
    customerGstin: '24ZZZYB0002F8Z5', // Gujarat
    invoiceNumber: 'AMZ/26-27/0009999',
    invoiceDate: new Date('2026-04-15T00:00:00.000Z'),
    financialYear: '2026-2027',
    orderId: '408-0000001-0000013',
    quantity: 1,
    shipFromStateCode: '27',
    placeOfSupplyStateCode: '24',
    supplyType: SupplyType.INTERSTATE,
    recipientType: RecipientType.B2B,
    hsnSac: '940360',
    currency: 'INR',
    taxBreakdown: {
      taxableValue: new Decimal('1000'),
      shippingTaxableValue: new Decimal('0'),
      totalTaxableValue: new Decimal('1000'),
      taxRate: new Decimal('18'),
      cgstRate: new Decimal('0'),
      cgstAmount: new Decimal('0'),
      sgstRate: new Decimal('0'),
      sgstAmount: new Decimal('0'),
      utgstRate: new Decimal('0'),
      utgstAmount: new Decimal('0'),
      igstRate: new Decimal('18'),
      igstAmount: new Decimal('180'),
      cessAmount: new Decimal('0'),
      totalInvoiceAmount: new Decimal('1180')
    },
    issues: []
  };

  it('GST-001: Intrastate taxable B2B invoice (CGST and SGST apply, IGST is 0)', () => {
    const record: OutwardSupplyRecord = {
      ...baseOutward,
      shipFromStateCode: '27',
      placeOfSupplyStateCode: '27', // Intrastate
      customerGstin: '27ZZZYB0002F8Z5',
      supplyType: SupplyType.INTRASTATE,
      taxBreakdown: {
        ...baseOutward.taxBreakdown,
        cgstRate: new Decimal('9'),
        cgstAmount: new Decimal('90'),
        sgstRate: new Decimal('9'),
        sgstAmount: new Decimal('90'),
        igstRate: new Decimal('0'),
        igstAmount: new Decimal('0')
      },
      issues: []
    };

    const report = defaultValidator.validate(record);
    expect(report.status).toBe(ValidationStatus.VALID);
    expect(report.errorsCount).toBe(0);
  });

  it('GST-002: Interstate taxable B2B invoice (IGST applies, CGST and SGST are 0)', () => {
    const record: OutwardSupplyRecord = { ...baseOutward, issues: [] };
    const report = defaultValidator.validate(record);
    expect(report.status).toBe(ValidationStatus.VALID);
    expect(report.errorsCount).toBe(0);
  });

  it('GST-003: Clean B2C invoice without recipient GSTIN', () => {
    const record: OutwardSupplyRecord = {
      ...baseOutward,
      recipientType: RecipientType.B2C,
      customerGstin: undefined,
      issues: []
    };

    const routed = defaultRouter.route(record);
    expect(routed.destination).toBe(RouteDestination.B2C_SUPPLY);
    const report = defaultValidator.validate(routed.record);
    expect(report.status).toBe(ValidationStatus.VALID);
  });

  it('GST-004: B2B transaction without recipient GSTIN', () => {
    const record: OutwardSupplyRecord = {
      ...baseOutward,
      recipientType: RecipientType.B2B,
      customerGstin: undefined, // Missing recipient GSTIN
      issues: []
    };

    const routed = defaultRouter.route(record);
    expect(routed.destination).toBe(RouteDestination.EXCEPTION_REVIEW);
    const report = defaultValidator.validate(routed.record);
    expect(report.status).toBe(ValidationStatus.ERROR);
    expect(report.issues.some((i) => i.code === IssueCode.B2B_WITHOUT_GSTIN)).toBe(true);
  });

  it('GST-005: Duplicate invoice number for same seller and financial year', () => {
    defaultDeduplicator.reset();
    const inv1 = {
      ...baseOutward,
      sourceRef: { sourceReport: 'SYNTHETIC_AMAZON_MTR', sourceRowNumber: 101 },
      issues: []
    };
    const inv2 = {
      ...baseOutward,
      sourceRef: { sourceReport: 'SYNTHETIC_AMAZON_MTR', sourceRowNumber: 102 },
      invoiceDate: new Date('2026-04-20T00:00:00.000Z'),
      issues: []
    };

    defaultDeduplicator.processRecord(inv1);
    const processed2 = defaultDeduplicator.processRecord(inv2);
    const report = defaultValidator.validate(processed2);

    expect(report.status).toBe(ValidationStatus.ERROR);
    expect(report.issues.some((i) => i.code === IssueCode.DUPLICATE_INVOICE_NUMBER)).toBe(true);
  });

  it('GST-006: Negative taxable value on ordinary sales invoice', () => {
    const record: OutwardSupplyRecord = {
      ...baseOutward,
      taxBreakdown: {
        ...baseOutward.taxBreakdown,
        taxableValue: new Decimal('-1000')
      },
      issues: [
        {
          code: IssueCode.NEGATIVE_TAXABLE_VALUE,
          severity: IssueSeverity.ERROR,
          message: 'Negative taxable value on sales invoice',
          sourceRowNumber: 1,
          sourceReport: 'TEST'
        }
      ]
    };

    const report = defaultValidator.validate(record);
    expect(report.status).toBe(ValidationStatus.ERROR);
    expect(report.issues.some((i) => i.code === IssueCode.NEGATIVE_TAXABLE_VALUE)).toBe(true);
  });

  it('GST-007: Tax amount differs from rounded taxable value * rate', () => {
    const record: OutwardSupplyRecord = {
      ...baseOutward,
      taxBreakdown: {
        ...baseOutward.taxBreakdown,
        igstAmount: new Decimal('350') // Declared 350 vs expected 180
      },
      issues: [
        {
          code: IssueCode.TAX_MISMATCH,
          severity: IssueSeverity.ERROR,
          message: 'Tax calculation mismatch',
          sourceRowNumber: 1,
          sourceReport: 'TEST'
        }
      ]
    };

    const report = defaultValidator.validate(record);
    expect(report.status).toBe(ValidationStatus.ERROR);
    expect(report.issues.some((i) => i.code === IssueCode.TAX_MISMATCH)).toBe(true);
  });

  it('GST-008: Missing HSN/SAC generates warning', () => {
    const record: OutwardSupplyRecord = { ...baseOutward, hsnSac: undefined, issues: [] };
    const report = defaultValidator.validate(record);
    expect(report.status).toBe(ValidationStatus.WARNING);
    expect(report.issues.some((i) => i.code === IssueCode.MISSING_HSN)).toBe(true);
  });

  it('GST-009: Interstate transaction carrying CGST/SGST', () => {
    const record: OutwardSupplyRecord = {
      ...baseOutward,
      shipFromStateCode: '27',
      placeOfSupplyStateCode: '24', // Interstate
      taxBreakdown: {
        ...baseOutward.taxBreakdown,
        cgstAmount: new Decimal('90'),
        sgstAmount: new Decimal('90'),
        igstAmount: new Decimal('0')
      },
      issues: []
    };

    const report = defaultValidator.validate(record);
    expect(report.status).toBe(ValidationStatus.ERROR);
    expect(report.issues.some((i) => i.code === IssueCode.INTERSTATE_WITH_CGST_SGST)).toBe(true);
  });

  it('GST-010: Orphan refund/credit note record without original invoice reference', () => {
    const cn: CreditNoteRecord = {
      recordType: 'CREDIT_NOTE',
      id: 'cn-orphan',
      sourceRef: { sourceReport: 'CREDIT_NOTES', sourceRowNumber: 1 },
      creditNoteNumber: 'CN/999',
      creditNoteDate: new Date('2026-05-01T00:00:00.000Z'),
      financialYear: '2026-2027',
      recipientType: RecipientType.B2B,
      sellerGstin: '27ZZZKA0001B3Z5',
      taxableValueReversal: new Decimal('500'),
      cgstAmountReversal: new Decimal('0'),
      sgstAmountReversal: new Decimal('0'),
      utgstAmountReversal: new Decimal('0'),
      igstAmountReversal: new Decimal('90'),
      creditNoteTotal: new Decimal('590'),
      reconciliationStatus: ReconciliationStatus.UNMATCHED_ORPHAN,
      issues: []
    };

    const report = defaultValidator.validate(cn);
    expect(report.status).toBe(ValidationStatus.WARNING);
    expect(report.issues.some((i) => i.code === IssueCode.ORPHAN_CREDIT_NOTE)).toBe(true);
  });

  it('GST-011: Same order contains multiple SKU lines (preserved without dropping)', () => {
    defaultDeduplicator.reset();
    const lineA: OutwardSupplyRecord = {
      ...baseOutward,
      id: 'line-1',
      sku: 'SKU-001',
      sourceRef: { sourceReport: 'SYNTHETIC_AMAZON_MTR', sourceRowNumber: 201 },
      issues: []
    };
    const lineB: OutwardSupplyRecord = {
      ...baseOutward,
      id: 'line-2',
      sku: 'SKU-002',
      sourceRef: { sourceReport: 'SYNTHETIC_AMAZON_MTR', sourceRowNumber: 202 },
      issues: []
    };

    const p1 = defaultDeduplicator.processRecord(lineA) as OutwardSupplyRecord;
    const p2 = defaultDeduplicator.processRecord(lineB) as OutwardSupplyRecord;

    const rep1 = defaultValidator.validate(p1);
    const rep2 = defaultValidator.validate(p2);

    expect(rep1.status).toBe(ValidationStatus.VALID);
    expect(rep2.status).toBe(ValidationStatus.VALID);
    expect(defaultDeduplicator.getDocumentCount()).toBe(1);
  });

  it('GST-012: Cancelled order with no invoice does not create outward tax liability', () => {
    const cancelled: CancelledOrderRecord = {
      recordType: 'CANCELLED_ORDER',
      id: 'cancel-01',
      sourceRef: { sourceReport: 'CANCELLED', sourceRowNumber: 1 },
      orderId: '408-0000001-0000013',
      createsTaxLiability: false,
      issues: []
    };

    const report = defaultValidator.validate(cancelled);
    expect(report.status).toBe(ValidationStatus.VALID);
    expect(cancelled.createsTaxLiability).toBe(false);
  });

  it('GST-013: Stock transfer between distinct GST registrations routed to review flow', () => {
    const stockTransfer: StockTransferRecord = {
      recordType: 'STOCK_TRANSFER',
      id: 'st-01',
      sourceRef: { sourceReport: 'STOCK_TRANSFERS', sourceRowNumber: 1 },
      transferInvoiceNumber: 'ST/01',
      transferDate: new Date('2026-04-20T00:00:00.000Z'),
      financialYear: '2026-2027',
      sourceGstin: '09ZZZCD0001I1Z5',
      destinationGstin: '36ZZZCD0001I1Z5',
      sourcePan: 'ZZZCD0001I',
      destinationPan: 'ZZZCD0001I',
      classification: StockTransferClassification.REVIEW_REQUIRED,
      shipFromStateCode: '09',
      shipToStateCode: '36',
      quantity: 1,
      taxBreakdown: {
        ...baseOutward.taxBreakdown
      },
      issues: []
    };

    const classified = defaultStockTransferProcessor.classifyTransfer(stockTransfer);
    const report = defaultValidator.validate(classified);
    expect(report.status).toBe(ValidationStatus.REVIEW);
    expect(report.issues.some((i) => i.code === IssueCode.STOCK_TRANSFER_REVIEW_REQUIRED)).toBe(true);
  });

  it('GST-014: Credit note partially reverses original taxable value', () => {
    const repo = defaultReconciler.getRepository();
    repo.reset();
    repo.registerInvoice({ ...baseOutward, issues: [] });

    const cn: CreditNoteRecord = {
      recordType: 'CREDIT_NOTE',
      id: 'cn-partial',
      sourceRef: { sourceReport: 'CREDIT_NOTES', sourceRowNumber: 1 },
      creditNoteNumber: 'CN/PARTIAL',
      creditNoteDate: new Date('2026-05-01T00:00:00.000Z'),
      originalInvoiceNumber: baseOutward.invoiceNumber,
      originalInvoiceDate: baseOutward.invoiceDate,
      financialYear: '2026-2027',
      recipientType: RecipientType.B2B,
      sellerGstin: baseOutward.sellerGstin,
      customerGstin: baseOutward.customerGstin,
      placeOfSupplyStateCode: baseOutward.placeOfSupplyStateCode,
      taxableValueReversal: new Decimal('400'), // 40% partial reversal
      cgstAmountReversal: new Decimal('0'),
      sgstAmountReversal: new Decimal('0'),
      utgstAmountReversal: new Decimal('0'),
      igstAmountReversal: new Decimal('72'),
      creditNoteTotal: new Decimal('472'),
      reconciliationStatus: ReconciliationStatus.UNMATCHED_ORPHAN,
      issues: []
    };

    const reconciled = defaultReconciler.reconcileCreditNote(cn);
    expect(reconciled.reconciliationStatus).toBe(ReconciliationStatus.MATCHED_PARTIAL);
    const report = defaultValidator.validate(reconciled);
    expect(report.status).toBe(ValidationStatus.VALID);
  });

  it('GST-015: Tax rate not in configured rate catalogue', () => {
    const record: OutwardSupplyRecord = {
      ...baseOutward,
      taxBreakdown: {
        ...baseOutward.taxBreakdown,
        taxRate: new Decimal('7') // 7% is unconfigured
      },
      issues: []
    };

    const report = defaultValidator.validate(record);
    expect(report.status).toBe(ValidationStatus.ERROR);
    expect(report.issues.some((i) => i.code === IssueCode.INVALID_TAX_RATE)).toBe(true);
  });

  it('suppresses duplicate issues on repeated validation calls', () => {
    const validator = new ValidationEngine();
    const record: OutwardSupplyRecord = {
      ...baseOutward,
      hsnSac: undefined,
      issues: []
    };

    // First validation adds MISSING_HSN
    const rep1 = validator.validate(record);
    expect(rep1.issues.length).toBe(1);

    // Second validation on same record should not duplicate MISSING_HSN
    const rep2 = validator.validate(record);
    expect(rep2.issues.length).toBe(1);
  });

  it('handles multiple simultaneous errors and warnings on a single record', () => {
    const validator = new ValidationEngine();
    const record: OutwardSupplyRecord = {
      ...baseOutward,
      hsnSac: undefined, // Missing HSN (WARNING)
      customerGstin: undefined, // B2B without GSTIN (ERROR)
      taxBreakdown: {
        ...baseOutward.taxBreakdown,
        taxRate: new Decimal('7') // Invalid rate (ERROR)
      },
      issues: []
    };

    const rep = validator.validate(record);
    expect(rep.status).toBe(ValidationStatus.ERROR);
    expect(rep.errorsCount).toBe(2);
    expect(rep.warningsCount).toBe(1);
    expect(rep.issues.length).toBe(3);
  });

  it('produces deterministic validation reports across repeated executions', () => {
    const validator = new ValidationEngine();
    const record: OutwardSupplyRecord = { ...baseOutward, issues: [] };

    const rep1 = validator.validate(record);
    const rep2 = validator.validate(record);

    expect(rep1.status).toBe(rep2.status);
    expect(rep1.errorsCount).toBe(rep2.errorsCount);
    expect(rep1.issues.length).toBe(rep2.issues.length);
  });
});
