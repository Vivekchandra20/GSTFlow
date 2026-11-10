import { describe, it, expect } from 'vitest';
import { defaultNormalizer } from '../../src/engine/normalizer.js';
import { RawMarketplaceRecord } from '../../src/adapters/base.adapter.js';
import { IssueCode, IssueSeverity, SupplyType, RecipientType } from '../../src/models/enums.js';

describe('NormalizerEngine - Outward Supply Normalization', () => {
  it('normalizes a valid B2B outward shipment row without errors', () => {
    const rawRecord: RawMarketplaceRecord = {
      sourceReport: 'SYNTHETIC_AMAZON_MTR_B2B',
      sourceRowNumber: 3,
      physicalLineNumber: 2,
      reportType: 'B2B',
      rawFields: {
        'Seller GSTIN': '09ZZZKA0001B3Z5',
        'Invoice Number': 'AMZ/26-27/0000001',
        'Invoice Date': '2026-04-13',
        'Transaction Type': 'Shipment',
        'Order ID': '408-0000001-0000013',
        'Shipment ID': 'SHP-000000001',
        'SKU': 'SKU-00100',
        'ASIN': 'B0PY704BK6',
        'HSN/SAC': '940360',
        'Quantity': '1',
        'Product Category': 'Accessories',
        'Customer Bill To GSTIN': '23ZZZYB0001F7Z5',
        'Recipient Type': 'B2B',
        'Ship From State Code': '09',
        'Ship From State': 'Uttar Pradesh',
        'Ship To State Code': '23',
        'Ship To State': 'Madhya Pradesh',
        'Place of Supply State Code': '23',
        'Place of Supply': 'Madhya Pradesh',
        'Taxable Value': '4865.56',
        'Shipping Taxable Value': '134.89',
        'Tax Rate': '18',
        'CGST Rate': '0',
        'CGST Amount': '0.0',
        'SGST Rate': '0',
        'SGST Amount': '0.0',
        'IGST Rate': '18',
        'IGST Amount': '900.08',
        'Compensatory Cess Amount': '0.0',
        'Invoice Amount': '5900.53',
        'Currency': 'INR',
        'Credit Note Number': '',
        'Credit Note Date': '',
        'Source Report': 'SYNTHETIC_AMAZON_MTR_B2B',
        'Source Row Number': '3'
      }
    };

    const normalized = defaultNormalizer.normalize(rawRecord);
    expect(normalized.recordType).toBe('OUTWARD_SUPPLY');
    if (normalized.recordType === 'OUTWARD_SUPPLY') {
      expect(normalized.invoiceNumber).toBe('AMZ/26-27/0000001');
      expect(normalized.financialYear).toBe('2026-2027');
      expect(normalized.supplyType).toBe(SupplyType.INTERSTATE);
      expect(normalized.recipientType).toBe(RecipientType.B2B);
      expect(normalized.taxBreakdown.totalTaxableValue.toString()).toBe('5000.45');
      expect(normalized.taxBreakdown.igstAmount.toString()).toBe('900.08');
      expect(normalized.taxBreakdown.totalInvoiceAmount.toString()).toBe('5900.53');
      expect(normalized.issues.length).toBe(0);
    }
  });

  it('detects negative taxable value on ordinary sales shipment (GST-006)', () => {
    const rawRecord: RawMarketplaceRecord = {
      sourceReport: 'SYNTHETIC_AMAZON_MTR_B2B',
      sourceRowNumber: 6,
      physicalLineNumber: 5,
      reportType: 'B2B',
      rawFields: {
        'Seller GSTIN': '33ZZZKA0004B6Z5',
        'Invoice Number': 'AMZ/26-27/0000004',
        'Invoice Date': '2026-04-12',
        'Transaction Type': 'Shipment',
        'Order ID': '408-0000004-0000052',
        'Shipment ID': 'SHP-000000004',
        'SKU': 'SKU-00272',
        'HSN/SAC': '610910',
        'Quantity': '1',
        'Customer Bill To GSTIN': '36ZZZYB0004F1Z5',
        'Recipient Type': 'B2B',
        'Ship From State Code': '33',
        'Place of Supply State Code': '36',
        'Taxable Value': '-2254.93', // Mutation: negative taxable value
        'Shipping Taxable Value': '0.0',
        'Tax Rate': '5',
        'IGST Rate': '5',
        'IGST Amount': '112.75',
        'Invoice Amount': '2367.68'
      }
    };

    const normalized = defaultNormalizer.normalize(rawRecord);
    const hasNegativeIssue = normalized.issues.some(
      (i) => i.code === IssueCode.NEGATIVE_TAXABLE_VALUE && i.severity === IssueSeverity.ERROR
    );
    expect(hasNegativeIssue).toBe(true);
  });

  it('detects tax calculation mismatch (GST-007)', () => {
    const rawRecord: RawMarketplaceRecord = {
      sourceReport: 'SYNTHETIC_AMAZON_MTR_B2B',
      sourceRowNumber: 7,
      physicalLineNumber: 6,
      reportType: 'B2B',
      rawFields: {
        'Seller GSTIN': '24ZZZKA0005B7Z5',
        'Invoice Number': 'AMZ/26-27/0000005',
        'Invoice Date': '2026-04-07',
        'Transaction Type': 'Shipment',
        'Order ID': '408-0000005-0000065',
        'Shipment ID': 'SHP-000000005',
        'SKU': 'SKU-00115',
        'HSN/SAC': '940360',
        'Quantity': '1',
        'Customer Bill To GSTIN': '27ZZZYB0005F2Z5',
        'Recipient Type': 'B2B',
        'Ship From State Code': '24',
        'Place of Supply State Code': '27',
        'Taxable Value': '1591.33',
        'Shipping Taxable Value': '0.0',
        'Tax Rate': '18',
        'CGST Rate': '0.0',
        'CGST Amount': '17.35', // Mutation: injected mismatch
        'SGST Rate': '0.0',
        'SGST Amount': '0.0',
        'IGST Rate': '18',
        'IGST Amount': '303.79', // Should be 286.44
        'Invoice Amount': '1877.77'
      }
    };

    const normalized = defaultNormalizer.normalize(rawRecord);
    const hasTaxMismatch = normalized.issues.some((i) => i.code === IssueCode.TAX_MISMATCH);
    expect(hasTaxMismatch).toBe(true);
  });

  it('flags missing HSN/SAC as a review warning (GST-008)', () => {
    const rawRecord: RawMarketplaceRecord = {
      sourceReport: 'SYNTHETIC_AMAZON_MTR_B2B',
      sourceRowNumber: 8,
      physicalLineNumber: 7,
      reportType: 'B2B',
      rawFields: {
        'Seller GSTIN': '19ZZZKA0006B8Z5',
        'Invoice Number': 'AMZ/26-27/0000006',
        'Invoice Date': '2026-04-27',
        'Transaction Type': 'Shipment',
        'Order ID': '408-0000006-0000078',
        'Quantity': '1',
        'Customer Bill To GSTIN': '08ZZZYB0006F3Z5',
        'Recipient Type': 'B2B',
        'Ship From State Code': '19',
        'Place of Supply State Code': '08',
        'Taxable Value': '9142.32',
        'Shipping Taxable Value': '72.54',
        'Tax Rate': '12',
        'IGST Rate': '12',
        'IGST Amount': '1105.78',
        'Invoice Amount': '10320.64',
        'HSN/SAC': '' // Missing HSN
      }
    };

    const normalized = defaultNormalizer.normalize(rawRecord);
    const hasMissingHsn = normalized.issues.some(
      (i) => i.code === IssueCode.MISSING_HSN && i.severity === IssueSeverity.WARNING
    );
    expect(hasMissingHsn).toBe(true);
  });

  it('flags interstate transaction carrying CGST/SGST (GST-009)', () => {
    const rawRecord: RawMarketplaceRecord = {
      sourceReport: 'SYNTHETIC_AMAZON_MTR_B2B',
      sourceRowNumber: 12,
      physicalLineNumber: 11,
      reportType: 'B2B',
      rawFields: {
        'Seller GSTIN': '23ZZZKA0010B3Z5',
        'Invoice Number': 'AMZ/26-27/0000010',
        'Invoice Date': '2026-04-26',
        'Transaction Type': 'Shipment',
        'Order ID': '408-0000010-0000130',
        'Customer Bill To GSTIN': '09ZZZYB0010F7Z5',
        'Recipient Type': 'B2B',
        'Ship From State Code': '23', // Madhya Pradesh
        'Place of Supply State Code': '09', // Uttar Pradesh (Interstate)
        'Taxable Value': '11391.0',
        'Shipping Taxable Value': '0.0',
        'Tax Rate': '18',
        'CGST Rate': '9.0',
        'CGST Amount': '1025.19', // Erroneously charged CGST on interstate
        'SGST Rate': '9.0',
        'SGST Amount': '1025.19', // Erroneously charged SGST on interstate
        'IGST Rate': '0',
        'IGST Amount': '0.0',
        'Invoice Amount': '13441.38',
        'HSN/SAC': '940360'
      }
    };

    const normalized = defaultNormalizer.normalize(rawRecord);
    const hasInterstateTaxConflict = normalized.issues.some(
      (i) => i.code === IssueCode.INTERSTATE_WITH_CGST_SGST && i.severity === IssueSeverity.ERROR
    );
    expect(hasInterstateTaxConflict).toBe(true);
  });

  it('flags unconfigured tax rate (GST-015)', () => {
    const rawRecord: RawMarketplaceRecord = {
      sourceReport: 'SYNTHETIC_AMAZON_MTR_B2B',
      sourceRowNumber: 20,
      physicalLineNumber: 19,
      reportType: 'B2B',
      rawFields: {
        'Seller GSTIN': '09ZZZKA0001B3Z5',
        'Invoice Number': 'AMZ/26-27/0000099',
        'Invoice Date': '2026-04-13',
        'Ship From State Code': '09',
        'Place of Supply State Code': '23',
        'Taxable Value': '1000.00',
        'Tax Rate': '7', // Unconfigured 7%
        'HSN/SAC': '940360'
      }
    };

    const normalized = defaultNormalizer.normalize(rawRecord);
    const hasInvalidRate = normalized.issues.some((i) => i.code === IssueCode.INVALID_TAX_RATE);
    expect(hasInvalidRate).toBe(true);
  });

  it('converts fatal date parsing failures into MalformedRecord without dropping record', () => {
    const rawRecord: RawMarketplaceRecord = {
      sourceReport: 'SYNTHETIC_AMAZON_MTR_B2B',
      sourceRowNumber: 5,
      physicalLineNumber: 4,
      reportType: 'B2B',
      rawFields: {
        'Seller GSTIN': '29ZZZKA0003B5Z5',
        'Invoice Number': 'AMZ/26-27/0000003',
        'Invoice Date': '31-99-2026', // Fatal invalid date
        'Taxable Value': '4780.3',
        'Tax Rate': '18',
        'HSN/SAC': '940360'
      }
    };

    const normalized = defaultNormalizer.normalize(rawRecord);
    expect(normalized.recordType).toBe('MALFORMED');
    if (normalized.recordType === 'MALFORMED') {
      expect(normalized.rawFields['Invoice Date']).toBe('31-99-2026');
      expect(normalized.issues.some((i) => i.code === IssueCode.INVALID_INVOICE_DATE)).toBe(true);
    }
  });

  it('converts missing invoice number into MalformedRecord without dropping record', () => {
    const rawRecord: RawMarketplaceRecord = {
      sourceReport: 'SYNTHETIC_AMAZON_MTR_B2B',
      sourceRowNumber: 10,
      physicalLineNumber: 9,
      reportType: 'B2B',
      rawFields: {
        'Seller GSTIN': '06ZZZKA0008B0Z5',
        'Invoice Number': '', // Missing invoice number
        'Invoice Date': '2026-04-02',
        'Taxable Value': '1517.48',
        'Tax Rate': '12',
        'HSN/SAC': '420222'
      }
    };

    const normalized = defaultNormalizer.normalize(rawRecord);
    expect(normalized.recordType).toBe('MALFORMED');
    if (normalized.recordType === 'MALFORMED') {
      expect(normalized.issues.some((i) => i.code === IssueCode.MISSING_INVOICE_NUMBER)).toBe(true);
    }
  });
});
