import { describe, it, expect, beforeEach } from 'vitest';
import { Decimal } from '../../src/utils/decimal.js';
import { DeduplicationEngine } from '../../src/engine/deduplicator.js';
import { OutwardSupplyRecord } from '../../src/models/transaction.schema.js';
import { RecipientType, SupplyType, IssueCode, IssueSeverity } from '../../src/models/enums.js';

describe('DeduplicationEngine - Multi-Line & Multi-SKU Preservation', () => {
  let deduplicator: DeduplicationEngine;

  beforeEach(() => {
    deduplicator = new DeduplicationEngine();
  });

  const createLine = (
    rowNumber: number,
    invoiceNumber: string,
    sku: string,
    financialYear: string = '2026-2027',
    dateStr: string = '2026-04-13',
    customerGstin: string = '23ZZZYB0001F7Z5',
    sellerGstin: string = '09ZZZKA0001B3Z5'
  ): OutwardSupplyRecord => ({
    recordType: 'OUTWARD_SUPPLY',
    id: `tx-${rowNumber}`,
    sourceRef: { sourceReport: 'SYNTHETIC_AMAZON_MTR_B2B', sourceRowNumber: rowNumber },
    sellerGstin,
    customerGstin,
    invoiceNumber,
    invoiceDate: new Date(`${dateStr}T00:00:00.000Z`),
    financialYear,
    orderId: '408-0000001-0000013',
    shipmentId: `SHP-${rowNumber}`,
    sku,
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
  });

  it('preserves multiple SKU lines belonging to the same invoice/order (GST-011)', () => {
    // Single invoice with 3 different SKU line items
    const line1 = createLine(1, 'AMZ/26-27/0000001', 'SKU-APPLE-01');
    const line2 = createLine(2, 'AMZ/26-27/0000001', 'SKU-BANANA-02');
    const line3 = createLine(3, 'AMZ/26-27/0000001', 'SKU-ORANGE-03');

    const processed1 = deduplicator.processRecord(line1) as OutwardSupplyRecord;
    const processed2 = deduplicator.processRecord(line2) as OutwardSupplyRecord;
    const processed3 = deduplicator.processRecord(line3) as OutwardSupplyRecord;

    expect(processed1.issues.length).toBe(0);
    expect(processed2.issues.length).toBe(0);
    expect(processed3.issues.length).toBe(0);

    // Document count is 1, but total lines registered is 3
    expect(deduplicator.getDocumentCount()).toBe(1);
    const docHeader = deduplicator.getDocumentHeader('09ZZZKA0001B3Z5', '2026-2027', 'AMZ/26-27/0000001');
    expect(docHeader?.totalLinesRegistered).toBe(3);
  });

  it('preserves multiple legitimate separate lines containing the same SKU on an invoice', () => {
    // E.g. Split shipment or promotional tiered pricing for the same SKU
    const line1 = createLine(10, 'AMZ/26-27/0000002', 'SKU-IDENTICAL');
    const line2 = createLine(11, 'AMZ/26-27/0000002', 'SKU-IDENTICAL');

    const processed1 = deduplicator.processRecord(line1) as OutwardSupplyRecord;
    const processed2 = deduplicator.processRecord(line2) as OutwardSupplyRecord;

    expect(processed1.issues.length).toBe(0);
    expect(processed2.issues.length).toBe(0);
    expect(deduplicator.getDocumentCount()).toBe(1);
  });

  it('flags duplicate invoice number with conflicting buyers or dates for same seller and FY (GST-005)', () => {
    // Original invoice issued to Buyer A on 2026-04-10
    const originalInvoice = createLine(20, 'AMZ/26-27/0000050', 'SKU-1', '2026-2027', '2026-04-10', '23ZZZYB0001F7Z5');
    // Subsequent row using same invoice number but conflicting Buyer B on 2026-04-20
    const conflictingInvoice = createLine(21, 'AMZ/26-27/0000050', 'SKU-2', '2026-2027', '2026-04-20', '24ZZZYB0002F8Z5');

    const p1 = deduplicator.processRecord(originalInvoice) as OutwardSupplyRecord;
    const p2 = deduplicator.processRecord(conflictingInvoice) as OutwardSupplyRecord;

    expect(p1.issues.length).toBe(0);
    const duplicateIssue = p2.issues.find((i) => i.code === IssueCode.DUPLICATE_INVOICE_NUMBER);
    expect(duplicateIssue).toBeDefined();
    expect(duplicateIssue?.severity).toBe(IssueSeverity.ERROR);
    expect(duplicateIssue?.message).toContain('buyer conflict');
    expect(duplicateIssue?.message).toContain('date conflict');
  });

  it('allows same invoice number across different financial years without flagging duplicate', () => {
    // In India GST, invoice numbering resets per financial year (April 1 - March 31)
    const invoiceFY25 = createLine(30, 'AMZ/00001', 'SKU-1', '2025-2026', '2026-03-15');
    const invoiceFY26 = createLine(31, 'AMZ/00001', 'SKU-1', '2026-2027', '2026-04-15');

    const p1 = deduplicator.processRecord(invoiceFY25) as OutwardSupplyRecord;
    const p2 = deduplicator.processRecord(invoiceFY26) as OutwardSupplyRecord;

    expect(p1.issues.length).toBe(0);
    expect(p2.issues.length).toBe(0);
    expect(deduplicator.getDocumentCount()).toBe(2);
  });

  it('detects repeated ingestion of the identical source record', () => {
    // Simulate ingesting the exact same source row twice (same report, same sourceRowNumber)
    const lineA = createLine(40, 'AMZ/26-27/0000099', 'SKU-1');
    const lineARepeat = createLine(40, 'AMZ/26-27/0000099', 'SKU-1');

    const p1 = deduplicator.processRecord(lineA) as OutwardSupplyRecord;
    const p2 = deduplicator.processRecord(lineARepeat) as OutwardSupplyRecord;

    expect(p1.issues.length).toBe(0);
    const repeatIssue = p2.issues.find((i) => i.code === IssueCode.DUPLICATE_LINE_ITEM);
    expect(repeatIssue).toBeDefined();
    expect(repeatIssue?.message).toContain('Repeated ingestion');
  });
});
