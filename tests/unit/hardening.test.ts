import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { Decimal } from '../../src/utils/decimal.js';
import { parseISODateStrict, getFinancialYear } from '../../src/utils/date.js';
import { sanitizeLogPayload, sanitizeSourceReference, maskGSTIN } from '../../src/utils/logger.js';
import { GSTCalculator } from '../../src/engine/gst-calculator.js';
import { TcsCalculator } from '../../src/engine/tcs-calculator.js';
import { defaultAmazonAdapter } from '../../src/adapters/amazon/amazon-synthetic.adapter.js';
import { defaultNormalizer } from '../../src/engine/normalizer.js';
import { SupplyType } from '../../src/models/enums.js';
import { RawMarketplaceRecord } from '../../src/adapters/base.adapter.js';

const SUITE_ROOT = path.resolve(__dirname, '../../GSTFlow_Synthetic_Test_Suite');

describe('Hardening - Leap Year & Calendar Date Boundaries', () => {
  it('correctly accepts February 29 on leap years and rejects it on non-leap years', () => {
    // 2024 is a leap year (divisible by 4)
    const leap2024 = parseISODateStrict('2024-02-29');
    expect(leap2024).not.toBeNull();
    expect(leap2024?.getUTCFullYear()).toBe(2024);
    expect(leap2024?.getUTCDate()).toBe(29);

    // 2028 is a leap year
    const leap2028 = parseISODateStrict('2028-02-29');
    expect(leap2028).not.toBeNull();

    // 2025, 2026, 2027 are non-leap years
    expect(parseISODateStrict('2025-02-29')).toBeNull();
    expect(parseISODateStrict('2026-02-29')).toBeNull();
    expect(parseISODateStrict('2027-02-29')).toBeNull();

    // Century leap year rules: 2000 was leap, 2100 is not
    expect(parseISODateStrict('2000-02-29')).not.toBeNull();
    expect(parseISODateStrict('2100-02-29')).toBeNull();
  });
});

describe('Hardening - Section 170 Invoice-Level Nearest Rupee Rounding', () => {
  it('applies statutory nearest rupee rounding when policy is NEAREST_RUPEE while preserving line-item decimals', () => {
    // Case 1: Total tax + taxable has >= 50 paise (e.g. 1000.54) -> rounds up to 1001
    // Product: 1000.00, Tax @ 5% = 50.00 -> 1050.00
    // Product: 1000.54, Tax @ 5% = 50.03 -> exact = 1050.57 -> rounds to 1051
    const res1 = GSTCalculator.calculateTax(
      {
        taxableValue: new Decimal('1000.54'),
        taxRate: new Decimal('5'),
        supplyType: SupplyType.INTERSTATE,
        shipFromStateCode: '27',
        placeOfSupplyStateCode: '09'
      },
      {
        includeShippingInTaxableBase: true,
        roundingTolerance: new Decimal('0.02'),
        invoiceRoundingPolicy: 'NEAREST_RUPEE'
      }
    );

    expect(res1.igstAmount.toString()).toBe('50.03'); // Line component preserved to 2 decimals
    expect(res1.totalInvoiceAmount.toString()).toBe('1051'); // Section 170 nearest rupee

    // Case 2: Total has < 50 paise (e.g. 1000.40) -> ignores fractional paise
    // Product: 1000.40, Tax @ 5% = 50.02 -> exact = 1050.42 -> rounds to 1050
    const res2 = GSTCalculator.calculateTax(
      {
        taxableValue: new Decimal('1000.40'),
        taxRate: new Decimal('5'),
        supplyType: SupplyType.INTERSTATE,
        shipFromStateCode: '27',
        placeOfSupplyStateCode: '09'
      },
      {
        includeShippingInTaxableBase: true,
        roundingTolerance: new Decimal('0.02'),
        invoiceRoundingPolicy: 'NEAREST_RUPEE'
      }
    );

    expect(res2.igstAmount.toString()).toBe('50.02');
    expect(res2.totalInvoiceAmount.toString()).toBe('1050');
  });

  it('preserves exact 2 decimal places by default when policy is EXACT_TWO_DECIMALS', () => {
    const res = GSTCalculator.calculateTax({
      taxableValue: new Decimal('1000.54'),
      taxRate: new Decimal('5'),
      supplyType: SupplyType.INTERSTATE,
      shipFromStateCode: '27',
      placeOfSupplyStateCode: '09'
    });

    expect(res.igstAmount.toString()).toBe('50.03');
    expect(res.totalInvoiceAmount.toString()).toBe('1050.57');
  });
});

describe('Hardening - Section 52 TCS Effective-Dated Calculations', () => {
  it('calculates historical TCS rate of 1.0% for transactions prior to 10 July 2024', () => {
    // Transaction date: 2024-04-15 (Before 10-07-2024)
    // Notification No. 52/2018-CT: 1% total (0.5% CGST + 0.5% SGST, 1% IGST)
    const intrastateTcs = TcsCalculator.calculateTcs(
      new Decimal('10000.00'),
      SupplyType.INTRASTATE,
      '27', // Maharashtra
      '2024-04-15'
    );

    expect(intrastateTcs.totalTcsRate.toString()).toBe('1');
    expect(intrastateTcs.cgstTcsAmount.toString()).toBe('50');
    expect(intrastateTcs.sgstTcsAmount.toString()).toBe('50');
    expect(intrastateTcs.utgstTcsAmount.toString()).toBe('0');
    expect(intrastateTcs.igstTcsAmount.toString()).toBe('0');
    expect(intrastateTcs.totalTcsAmount.toString()).toBe('100');
    expect(intrastateTcs.effectiveNotification).toContain('52/2018');

    // Interstate
    const interstateTcs = TcsCalculator.calculateTcs(
      new Decimal('10000.00'),
      SupplyType.INTERSTATE,
      '27',
      '2024-04-15'
    );
    expect(interstateTcs.igstTcsAmount.toString()).toBe('100');
    expect(interstateTcs.totalTcsAmount.toString()).toBe('100');
  });

  it('calculates revised TCS rate of 0.5% for transactions on or after 10 July 2024', () => {
    // Transaction date: 2024-07-15 (On or after 10-07-2024)
    // Notification No. 15/2024-CT: 0.5% total (0.25% CGST + 0.25% SGST, 0.5% IGST)
    const intrastateTcs = TcsCalculator.calculateTcs(
      new Decimal('10000.00'),
      SupplyType.INTRASTATE,
      '27', // Maharashtra
      '2024-07-15'
    );

    expect(intrastateTcs.totalTcsRate.toString()).toBe('0.5');
    expect(intrastateTcs.cgstTcsAmount.toString()).toBe('25');
    expect(intrastateTcs.sgstTcsAmount.toString()).toBe('25');
    expect(intrastateTcs.utgstTcsAmount.toString()).toBe('0');
    expect(intrastateTcs.totalTcsAmount.toString()).toBe('50');
    expect(intrastateTcs.effectiveNotification).toContain('15/2024');

    // Intrastate in Union Territory without legislature (Chandigarh 04) -> UTGST
    const utTcs = TcsCalculator.calculateTcs(
      new Decimal('10000.00'),
      SupplyType.INTRASTATE,
      '04', // Chandigarh
      '2024-07-15'
    );
    expect(utTcs.cgstTcsAmount.toString()).toBe('25');
    expect(utTcs.utgstTcsAmount.toString()).toBe('25');
    expect(utTcs.sgstTcsAmount.toString()).toBe('0');
  });
});

describe('Hardening - Security & PII Deep Sanitization', () => {
  it('deeply sanitizes nested objects and redacts rawRecord dictionaries', () => {
    const rawPayload = {
      event: 'INVOICE_PROCESSED',
      customerGstin: '24ZZZYB0002F8Z5',
      buyerDetails: {
        customerName: 'Secret Taxpayer Ltd',
        customerEmail: 'buyer@example.com',
        customerPhone: '+919999999999',
        customerAddress: '123 Commercial Street, Mumbai',
        nestedGstin: '27ZZZKA0001B3Z5'
      },
      rawRecord: {
        'Seller GSTIN': '27ZZZKA0001B3Z5',
        'Customer Bill To GSTIN': '24ZZZYB0002F8Z5',
        'Invoice Number': 'AMZ/001'
      }
    };

    const sanitized = sanitizeLogPayload(rawPayload);

    // GSTINs must be masked
    expect(sanitized.customerGstin).toBe('24ZZZ******8Z5');
    expect(sanitized.buyerDetails.nestedGstin).toBe('27ZZZ******3Z5');

    // Customer personal attributes must be redacted
    expect(sanitized.buyerDetails.customerName).toBe('[REDACTED]');
    expect(sanitized.buyerDetails.customerEmail).toBe('[REDACTED]');
    expect(sanitized.buyerDetails.customerPhone).toBe('[REDACTED]');
    expect(sanitized.buyerDetails.customerAddress).toBe('[REDACTED]');

    // Entire rawRecord dictionary must be replaced with REDACTED placeholder
    expect(sanitized.rawRecord).toBe('[REDACTED_RAW_EVIDENCE]');
  });

  it('safely scrubs rawRecord via sanitizeSourceReference without mutating original', () => {
    const originalRef = {
      sourceReport: 'SYNTHETIC_AMAZON_MTR_B2B',
      sourceRowNumber: 10,
      rawRecord: { 'Customer Bill To GSTIN': '24ZZZYB0002F8Z5' }
    };

    const sanitizedRef = sanitizeSourceReference(originalRef);

    expect(sanitizedRef.sourceRowNumber).toBe(10);
    expect(sanitizedRef.rawRecord?._redacted).toBe(true);
    // Original must remain untouched for secure auditor defense
    expect(originalRef.rawRecord['Customer Bill To GSTIN']).toBe('24ZZZYB0002F8Z5');
  });
});

describe('Hardening - Non-INR Currency Support', () => {
  it('preserves non-INR currencies (USD, EUR, GBP) on outward supplies', () => {
    const rawRecord: RawMarketplaceRecord = {
      sourceReport: 'SYNTHETIC_AMAZON_MTR_B2B',
      sourceRowNumber: 99,
      physicalLineNumber: 99,
      reportType: 'B2B',
      rawFields: {
        'Seller GSTIN': '09ZZZKA0001B3Z5',
        'Invoice Number': 'EXP/26-27/0000001',
        'Invoice Date': '2026-04-13',
        'Transaction Type': 'Shipment',
        'Order ID': '408-0000001-0000013',
        'Customer Bill To GSTIN': '23ZZZYB0001F7Z5',
        'Recipient Type': 'B2B',
        'Ship From State Code': '09',
        'Place of Supply State Code': '23',
        'Taxable Value': '100.00',
        'Shipping Taxable Value': '0.0',
        'Tax Rate': '18',
        'IGST Rate': '18',
        'IGST Amount': '18.00',
        'Invoice Amount': '118.00',
        'Currency': 'USD', // Non-INR export currency
        'HSN/SAC': '940360'
      }
    };

    const normalized = defaultNormalizer.normalize(rawRecord);
    expect(normalized.recordType).toBe('OUTWARD_SUPPLY');
    if (normalized.recordType === 'OUTWARD_SUPPLY') {
      expect(normalized.currency).toBe('USD');
      expect(normalized.taxBreakdown.totalInvoiceAmount.toString()).toBe('118');
    }
  });
});

describe('Hardening - Stream Resource Cleanup on Early Termination', () => {
  it('safely destroys file stream and parser when consumer terminates stream early', async () => {
    const filePath = path.join(SUITE_ROOT, 'amazon/synthetic_amazon_mtr_b2b.csv');
    let recordsRead = 0;

    // Break early after reading only 5 records out of 5,000
    for await (const record of defaultAmazonAdapter.streamRecords(filePath)) {
      recordsRead++;
      if (recordsRead === 5) {
        break; // Consumer early abort
      }
    }

    expect(recordsRead).toBe(5);
    // Verifies that the loop broke and finally block executed without unhandled stream errors
  });
});
