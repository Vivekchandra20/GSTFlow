import { describe, it, expect } from 'vitest';
import { Decimal } from '../../src/utils/decimal.js';
import { defaultTaxRateCatalogue, TaxRateCatalogue } from '../../src/models/tax-catalogue.js';
import {
  NormalizedRecordSchema,
  OutwardSupplyRecord,
  CreditNoteRecord,
  CancelledOrderRecord,
  StockTransferRecord
} from '../../src/models/transaction.schema.js';
import {
  RecipientType,
  SupplyType,
  StockTransferClassification,
  ReconciliationStatus
} from '../../src/models/enums.js';

describe('Tax Rate Catalogue', () => {
  it('contains verified standard GST slabs', () => {
    expect(defaultTaxRateCatalogue.isRateValid(0)).toBe(true);
    expect(defaultTaxRateCatalogue.isRateValid(5)).toBe(true);
    expect(defaultTaxRateCatalogue.isRateValid(12)).toBe(true);
    expect(defaultTaxRateCatalogue.isRateValid(18)).toBe(true);
    expect(defaultTaxRateCatalogue.isRateValid(28)).toBe(true);
  });

  it('contains verified special rates including 1% affordable housing (Notification No. 03/2019-CT(Rate))', () => {
    // 0.25% rough diamonds
    const r025 = defaultTaxRateCatalogue.findRate('0.25', '2026-04-01');
    expect(r025).not.toBeNull();
    expect(r025?.cgstRate.toString()).toBe('0.125');
    expect(r025?.sgstRate.toString()).toBe('0.125');

    // 1% affordable housing
    const r1 = defaultTaxRateCatalogue.findRate('1', '2026-04-01');
    expect(r1).not.toBeNull();
    expect(r1?.cgstRate.toString()).toBe('0.5');
    expect(r1?.sgstRate.toString()).toBe('0.5');
    expect(r1?.notificationReference).toContain('03/2019');

    // 3% gold/silver
    const r3 = defaultTaxRateCatalogue.findRate('3', '2026-04-01');
    expect(r3).not.toBeNull();
    expect(r3?.cgstRate.toString()).toBe('1.5');
  });

  it('flags unconfigured or speculative tax rates', () => {
    expect(defaultTaxRateCatalogue.isRateValid('7')).toBe(false);
    expect(defaultTaxRateCatalogue.isRateValid('15')).toBe(false);
    expect(defaultTaxRateCatalogue.isRateValid('1.5')).toBe(false); // 1.5% is not a recognized GST rate
  });
});

describe('Normalized Record Discriminated Union Schemas', () => {
  it('validates an OutwardSupplyRecord properly', () => {
    const rawOutward: OutwardSupplyRecord = {
      recordType: 'OUTWARD_SUPPLY',
      id: 'tx-001',
      sourceRef: {
        sourceReport: 'SYNTHETIC_AMAZON_MTR_B2B',
        sourceRowNumber: 2
      },
      sellerGstin: '09ZZZKA0001B3Z5',
      customerGstin: '23ZZZYB0001F7Z5',
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
        taxableValue: new Decimal('4865.56'),
        shippingTaxableValue: new Decimal('134.89'),
        totalTaxableValue: new Decimal('5000.45'),
        taxRate: new Decimal('18'),
        cgstRate: new Decimal('0'),
        cgstAmount: new Decimal('0'),
        sgstRate: new Decimal('0'),
        sgstAmount: new Decimal('0'),
        utgstRate: new Decimal('0'),
        utgstAmount: new Decimal('0'),
        igstRate: new Decimal('18'),
        igstAmount: new Decimal('900.08'),
        cessAmount: new Decimal('0'),
        totalInvoiceAmount: new Decimal('5900.53')
      },
      issues: []
    };

    const parsed = NormalizedRecordSchema.safeParse(rawOutward);
    expect(parsed.success).toBe(true);
  });

  it('validates a CancelledOrderRecord without requiring taxable amounts', () => {
    const cancelledOrder: CancelledOrderRecord = {
      recordType: 'CANCELLED_ORDER',
      id: 'cancel-001',
      sourceRef: {
        sourceReport: 'SYNTHETIC_AMAZON_MTR_B2B',
        sourceRowNumber: 15
      },
      orderId: '408-0000099-0000999',
      reason: 'Buyer cancelled prior to invoice generation',
      createsTaxLiability: false,
      issues: []
    };

    const parsed = NormalizedRecordSchema.safeParse(cancelledOrder);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.recordType).toBe('CANCELLED_ORDER');
    }
  });

  it('validates StockTransferRecord with StockTransferClassification', () => {
    const stockTransfer: StockTransferRecord = {
      recordType: 'STOCK_TRANSFER',
      id: 'st-001',
      sourceRef: {
        sourceReport: 'SYNTHETIC_AMAZON_STOCK_TRANSFER',
        sourceRowNumber: 2
      },
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

    const parsed = NormalizedRecordSchema.safeParse(stockTransfer);
    expect(parsed.success).toBe(true);
  });
});
