import { describe, it, expect } from 'vitest';
import { Decimal } from '../../src/utils/decimal.js';
import { RouterEngine, RouteDestination, evaluateGSTINEvidence, GSTINEvidenceStatus } from '../../src/engine/router.js';
import { OutwardSupplyRecord, CancelledOrderRecord, StockTransferRecord } from '../../src/models/transaction.schema.js';
import { RecipientType, SupplyType, IssueCode, IssueSeverity, StockTransferClassification } from '../../src/models/enums.js';

describe('RouterEngine - GSTIN Evidence Evaluation', () => {
  it('correctly evaluates missing, invalid, and unverified synthetic GSTINs', () => {
    expect(evaluateGSTINEvidence('')).toBe(GSTINEvidenceStatus.MISSING);
    expect(evaluateGSTINEvidence(undefined)).toBe(GSTINEvidenceStatus.MISSING);
    expect(evaluateGSTINEvidence('INVALID_GSTIN')).toBe(GSTINEvidenceStatus.INVALID_FORMAT);
    expect(evaluateGSTINEvidence('99ZZZYB0002F8Z5')).toBe(GSTINEvidenceStatus.INVALID_FORMAT); // 99 is invalid state
    expect(evaluateGSTINEvidence('24ZZZYB0002F8Z5')).toBe(GSTINEvidenceStatus.UNVERIFIED_SYNTHETIC); // Valid structural format
  });
});

describe('RouterEngine - B2B vs B2C Routing', () => {
  const router = new RouterEngine();

  const baseOutwardRecord: OutwardSupplyRecord = {
    recordType: 'OUTWARD_SUPPLY',
    id: 'tx-test',
    sourceRef: { sourceReport: 'SYNTHETIC_AMAZON_MTR', sourceRowNumber: 10 },
    sellerGstin: '09ZZZKA0001B3Z5',
    invoiceNumber: 'AMZ/26-27/0000001',
    invoiceDate: new Date('2026-04-13T00:00:00.000Z'),
    financialYear: '2026-2027',
    orderId: '408-0000001-0000013',
    quantity: 1,
    shipFromStateCode: '09',
    placeOfSupplyStateCode: '23',
    supplyType: SupplyType.INTERSTATE,
    recipientType: RecipientType.B2B,
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

  it('routes valid B2B invoice with recipient GSTIN to B2B_SUPPLY workflow (GST-002)', () => {
    const record: OutwardSupplyRecord = {
      ...baseOutwardRecord,
      customerGstin: '23ZZZYB0001F7Z5',
      recipientType: RecipientType.B2B
    };

    const routed = router.route(record);
    expect(routed.destination).toBe(RouteDestination.B2B_SUPPLY);
    expect(routed.record.issues.length).toBe(0);
  });

  it('flags B2B invoice without recipient GSTIN with B2B_WITHOUT_GSTIN and never converts to B2C (GST-004)', () => {
    const record: OutwardSupplyRecord = {
      ...baseOutwardRecord,
      customerGstin: undefined, // Missing recipient GSTIN
      recipientType: RecipientType.B2B,
      issues: []
    };

    const routed = router.route(record);
    expect(routed.destination).toBe(RouteDestination.EXCEPTION_REVIEW);
    expect(routed.record.recipientType).toBe(RecipientType.B2B); // Must NOT be changed to B2C!
    const hasIssue = routed.record.issues.some(
      (i) => i.code === IssueCode.B2B_WITHOUT_GSTIN && i.severity === IssueSeverity.ERROR
    );
    expect(hasIssue).toBe(true);
  });

  it('routes B2C invoice without recipient GSTIN to B2C_SUPPLY workflow (GST-003)', () => {
    const record: OutwardSupplyRecord = {
      ...baseOutwardRecord,
      customerGstin: undefined, // Blank for B2C
      recipientType: RecipientType.B2C,
      issues: []
    };

    const routed = router.route(record);
    expect(routed.destination).toBe(RouteDestination.B2C_SUPPLY);
    expect(routed.record.customerGstin).toBeUndefined(); // Does not fabricate GSTIN
    expect(routed.record.issues.length).toBe(0);
  });

  it('routes B2C invoice with unexpected populated customer GSTIN to EXCEPTION_REVIEW for human audit', () => {
    const record: OutwardSupplyRecord = {
      ...baseOutwardRecord,
      customerGstin: '23ZZZYB0001F7Z5', // Unexpected GSTIN on B2C
      recipientType: RecipientType.B2C,
      issues: []
    };

    const routed = router.route(record);
    expect(routed.destination).toBe(RouteDestination.EXCEPTION_REVIEW);
    expect(routed.record.issues.length).toBeGreaterThan(0);
  });

  it('routes CancelledOrderRecord to CANCELLED_ORDER without creating outward tax liability (GST-012)', () => {
    const cancelled: CancelledOrderRecord = {
      recordType: 'CANCELLED_ORDER',
      id: 'cancel-100',
      sourceRef: { sourceReport: 'SYNTHETIC_AMAZON_MTR', sourceRowNumber: 50 },
      orderId: '408-0000099-0000999',
      createsTaxLiability: false,
      issues: []
    };

    const routed = router.route(cancelled);
    expect(routed.destination).toBe(RouteDestination.CANCELLED_ORDER);
  });

  it('routes StockTransferRecord to STOCK_TRANSFER workflow (GST-013)', () => {
    const stockTransfer: StockTransferRecord = {
      recordType: 'STOCK_TRANSFER',
      id: 'st-100',
      sourceRef: { sourceReport: 'SYNTHETIC_AMAZON_STOCK_TRANSFER', sourceRowNumber: 2 },
      transferInvoiceNumber: 'ST/26-27/000001',
      transferDate: new Date('2026-04-24T00:00:00.000Z'),
      financialYear: '2026-2027',
      sourceGstin: '09ZZZCD0001I1Z5',
      destinationGstin: '36ZZZMD0001J2Z5',
      sourcePan: 'ZZZCD0001I',
      destinationPan: 'ZZZMD0001J',
      classification: StockTransferClassification.REVIEW_REQUIRED,
      shipFromStateCode: '09',
      shipToStateCode: '36',
      quantity: 1,
      taxBreakdown: {
        taxableValue: new Decimal('26167.92'),
        shippingTaxableValue: new Decimal('0'),
        totalTaxableValue: new Decimal('26167.92'),
        taxRate: new Decimal('12'),
        cgstRate: new Decimal('0'),
        cgstAmount: new Decimal('0'),
        sgstRate: new Decimal('0'),
        sgstAmount: new Decimal('0'),
        utgstRate: new Decimal('0'),
        utgstAmount: new Decimal('0'),
        igstRate: new Decimal('12'),
        igstAmount: new Decimal('3140.15'),
        cessAmount: new Decimal('0'),
        totalInvoiceAmount: new Decimal('29308.07')
      },
      issues: []
    };

    const routed = router.route(stockTransfer);
    expect(routed.destination).toBe(RouteDestination.STOCK_TRANSFER);
  });
});
