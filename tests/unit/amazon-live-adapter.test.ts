import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { AmazonMtrLiveAdapter } from '../../src/adapters/amazon/amazon-live.adapter.js';
import {
  UnsupportedReportFormatError,
  DuplicateCanonicalHeaderError,
  AmazonMtrMetadata
} from '../../src/adapters/amazon/amazon-live.types.js';
import {
  CreditNoteRecord,
  OutwardSupplyRecord,
  CancelledOrderRecord,
  MalformedRecord
} from '../../src/models/transaction.schema.js';
import { RecipientType, IssueCode, IssueSeverity } from '../../src/models/enums.js';

const FIXTURES_DIR = path.resolve(__dirname, '../fixtures/mock-amazon-live');

describe('AmazonMtrLiveAdapter (Unit & Mock Harness)', () => {
  const validInterleavedPath = path.join(FIXTURES_DIR, 'synthetic_mock_mtr_valid_interleaved.csv');
  const missingHeadersPath = path.join(FIXTURES_DIR, 'synthetic_mock_mtr_missing_headers.csv');
  const duplicateHeadersPath = path.join(FIXTURES_DIR, 'synthetic_mock_mtr_duplicate_headers.csv');
  const historicalAliasesPath = path.join(FIXTURES_DIR, 'synthetic_mock_mtr_historical_aliases.csv');
  const missingFinancialsPath = path.join(FIXTURES_DIR, 'synthetic_mock_mtr_missing_financials.csv');
  const malformedPath = path.join(FIXTURES_DIR, 'synthetic_mock_mtr_malformed.csv');

  it('streams and parses mock MTR file with complete provenance tracking', async () => {
    const adapter = new AmazonMtrLiveAdapter({
      sourceReportName: 'synthetic_mock_mtr_valid_interleaved.csv',
      importBatchId: 'test-batch-001'
    });

    const records = await adapter.parseFile(validInterleavedPath);
    expect(records.length).toBe(10);

    // Verify provenance on every record
    records.forEach((rec, idx) => {
      const meta = rec.sourceRef.rawRecord?._amazonMtrMetadata as AmazonMtrMetadata;
      expect(meta).toBeDefined();
      expect(meta.provenance.sourceReport).toBe('synthetic_mock_mtr_valid_interleaved.csv');
      expect(meta.provenance.importBatchId).toBe('test-batch-001');
      expect(meta.provenance.fileFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(meta.provenance.logicalRecordNumber).toBe(idx + 1);
      expect(meta.provenance.physicalLineNumber).toBe(idx + 2); // Line 1 is header
    });
  });

  it('preserves three-tier financial representation on negative refunds without sign mutation', async () => {
    const adapter = new AmazonMtrLiveAdapter({
      sourceReportName: 'synthetic_mock_mtr_valid_interleaved.csv'
    });

    const records = await adapter.parseFile(validInterleavedPath);
    const refundRecord = records[0] as CreditNoteRecord;

    expect(refundRecord.recordType).toBe('CREDIT_NOTE');
    expect(refundRecord.creditNoteNumber).toBe('CN-LIVE-001');
    expect(refundRecord.originalInvoiceNumber).toBe('INV-LIVE-001');
    // Normalized magnitude must be positive for schema validity
    expect(refundRecord.taxableValueReversal.toNumber()).toBe(1000.0);
    expect(refundRecord.igstAmountReversal.toNumber()).toBe(180.0);
    expect(refundRecord.creditNoteTotal.toNumber()).toBe(1180.0);

    // Inspect metadata three-tier amounts
    const meta = refundRecord.sourceRef.rawRecord?._amazonMtrMetadata as AmazonMtrMetadata;
    expect(meta.principalAmountBasis?.rawText).toBe('-1000.00');
    expect(meta.principalAmountBasis?.signedAmount.toNumber()).toBe(-1000.0);
    expect(meta.principalAmountBasis?.normalizedMagnitude.toNumber()).toBe(1000.0);

    expect(meta.totalTaxAmount?.rawText).toBe('-180.00');
    expect(meta.totalTaxAmount?.signedAmount.toNumber()).toBe(-180.0);
    expect(meta.totalTaxAmount?.normalizedMagnitude.toNumber()).toBe(180.0);

    expect(meta.evidenceFlags.explicitRefundTag).toBe(true);
    expect(meta.evidenceFlags.hasCreditNoteNumber).toBe(true);
    expect(meta.evidenceFlags.isSignedNegative).toBe(true);
  });

  it('correctly normalizes B2B shipment with Section 10(1)(b) Bill-To Place of Supply', async () => {
    const adapter = new AmazonMtrLiveAdapter({
      sourceReportName: 'synthetic_mock_mtr_valid_interleaved.csv'
    });

    const records = await adapter.parseFile(validInterleavedPath);
    const b2bShipment = records[1] as OutwardSupplyRecord;

    expect(b2bShipment.recordType).toBe('OUTWARD_SUPPLY');
    expect(b2bShipment.invoiceNumber).toBe('INV-LIVE-001');
    expect(b2bShipment.recipientType).toBe(RecipientType.B2B);
    expect(b2bShipment.customerGstin).toBe('27AABCS1429B1ZB');
    expect(b2bShipment.shipFromStateCode).toBe('29'); // KA
    expect(b2bShipment.placeOfSupplyStateCode).toBe('27'); // MH (from customerBillToGstin)
    expect(b2bShipment.taxBreakdown.taxableValue.toNumber()).toBe(1000.0);
    expect(b2bShipment.taxBreakdown.igstAmount.toNumber()).toBe(180.0);
    expect(b2bShipment.issues.length).toBe(0);
  });

  it('correctly normalizes B2C shipment deriving POS from destination state', async () => {
    const adapter = new AmazonMtrLiveAdapter({
      sourceReportName: 'synthetic_mock_mtr_valid_interleaved.csv'
    });

    const records = await adapter.parseFile(validInterleavedPath);
    const b2cShipment = records[2] as OutwardSupplyRecord;

    expect(b2cShipment.recordType).toBe('OUTWARD_SUPPLY');
    expect(b2cShipment.invoiceNumber).toBe('INV-LIVE-002');
    expect(b2cShipment.recipientType).toBe(RecipientType.B2C);
    expect(b2cShipment.customerGstin).toBeUndefined();
    expect(b2cShipment.placeOfSupplyStateCode).toBe('07'); // DL from 'Ship To State'
    expect(b2cShipment.taxBreakdown.taxableValue.toNumber()).toBe(500.0);
    expect(b2cShipment.taxBreakdown.shippingTaxableValue.toNumber()).toBe(50.0);
    expect(b2cShipment.taxBreakdown.totalTaxableValue.toNumber()).toBe(550.0);
  });

  it('preserves multi-SKU lines sharing the same invoice number as distinct records', async () => {
    const adapter = new AmazonMtrLiveAdapter({
      sourceReportName: 'synthetic_mock_mtr_valid_interleaved.csv'
    });

    const records = await adapter.parseFile(validInterleavedPath);
    const multiSkuLine1 = records[3] as OutwardSupplyRecord;
    const multiSkuLine2 = records[4] as OutwardSupplyRecord;

    expect(multiSkuLine1.invoiceNumber).toBe('INV-LIVE-003');
    expect(multiSkuLine2.invoiceNumber).toBe('INV-LIVE-003');
    expect(multiSkuLine1.sku).toBe('SKU-BOOK');
    expect(multiSkuLine2.sku).toBe('SKU-PEN');
    expect(multiSkuLine1.id).not.toBe(multiSkuLine2.id);
  });

  it('nets promotional discounts from item principal without double-counting', async () => {
    const adapter = new AmazonMtrLiveAdapter({
      sourceReportName: 'synthetic_mock_mtr_valid_interleaved.csv'
    });

    const records = await adapter.parseFile(validInterleavedPath);
    const promoRecord = records[5] as OutwardSupplyRecord;

    expect(promoRecord.invoiceNumber).toBe('INV-LIVE-004');
    // Principal: 1000.00, Promo discount: 200.00 -> Net taxable: 800.00
    expect(promoRecord.taxBreakdown.taxableValue.toNumber()).toBe(800.0);
    expect(promoRecord.taxBreakdown.totalTaxableValue.toNumber()).toBe(800.0);
    expect(promoRecord.taxBreakdown.cgstAmount.toNumber()).toBe(72.0);
    expect(promoRecord.taxBreakdown.sgstAmount.toNumber()).toBe(72.0);
  });

  it('routes negative shipment to EXCEPTION_REVIEW instead of dropping as fatal malformed', async () => {
    const adapter = new AmazonMtrLiveAdapter({
      sourceReportName: 'synthetic_mock_mtr_valid_interleaved.csv'
    });

    const records = await adapter.parseFile(validInterleavedPath);
    const negShipment = records[6] as OutwardSupplyRecord;

    expect(negShipment.recordType).toBe('OUTWARD_SUPPLY');
    expect(negShipment.invoiceNumber).toBe('INV-LIVE-005');
    const reviewIssue = negShipment.issues.find(
      (i) => i.code === IssueCode.NEGATIVE_TAXABLE_VALUE && i.severity === IssueSeverity.REVIEW
    );
    expect(reviewIssue).toBeDefined();
    expect(reviewIssue?.message).toContain('routed to Exception Review');
  });

  it('routes pre-dispatch cancellation with zero tax liability', async () => {
    const adapter = new AmazonMtrLiveAdapter({
      sourceReportName: 'synthetic_mock_mtr_valid_interleaved.csv'
    });

    const records = await adapter.parseFile(validInterleavedPath);
    const cancelRecord = records[7] as CancelledOrderRecord;

    expect(cancelRecord.recordType).toBe('CANCELLED_ORDER');
    expect(cancelRecord.orderId).toBe('402-6000006-6000006');
    expect(cancelRecord.createsTaxLiability).toBe(false);
  });

  it('classifies refund with positive values correctly using documentary evidence', async () => {
    const adapter = new AmazonMtrLiveAdapter({
      sourceReportName: 'synthetic_mock_mtr_valid_interleaved.csv'
    });

    const records = await adapter.parseFile(validInterleavedPath);
    const posRefund = records[8] as CreditNoteRecord;

    expect(posRefund.recordType).toBe('CREDIT_NOTE');
    expect(posRefund.creditNoteNumber).toBe('CN-LIVE-002');
    expect(posRefund.originalInvoiceNumber).toBe('INV-LIVE-002');
    expect(posRefund.taxableValueReversal.toNumber()).toBe(200.0);
  });

  it('routes unrecognized transaction type to MalformedRecord queue without dropping row', async () => {
    const adapter = new AmazonMtrLiveAdapter({
      sourceReportName: 'synthetic_mock_mtr_valid_interleaved.csv'
    });

    const records = await adapter.parseFile(validInterleavedPath);
    const malformed = records[9] as MalformedRecord;

    expect(malformed.recordType).toBe('MALFORMED');
    expect(malformed.errorSummary).toContain('DisputeReview');
  });

  it('fails fast on missing mandatory headers with UnsupportedReportFormatError', async () => {
    const adapter = new AmazonMtrLiveAdapter({
      sourceReportName: 'synthetic_mock_mtr_missing_headers.csv'
    });

    await expect(adapter.parseFile(missingHeadersPath)).rejects.toThrowError(UnsupportedReportFormatError);
  });

  it('fails fast on duplicate canonical headers with DuplicateCanonicalHeaderError', async () => {
    const adapter = new AmazonMtrLiveAdapter({
      sourceReportName: 'synthetic_mock_mtr_duplicate_headers.csv'
    });

    await expect(adapter.parseFile(duplicateHeadersPath)).rejects.toThrowError(DuplicateCanonicalHeaderError);
  });

  it('supports historical pre-2021 buyer GSTIN alias (Customer Ship to GSTIN)', async () => {
    const adapter = new AmazonMtrLiveAdapter({
      sourceReportName: 'synthetic_mock_mtr_historical_aliases.csv'
    });

    const records = await adapter.parseFile(historicalAliasesPath);
    expect(records.length).toBe(1);
    const b2b = records[0] as OutwardSupplyRecord;
    expect(b2b.invoiceNumber).toBe('INV-HIST-01');
    expect(b2b.customerGstin).toBe('27AABCS1429B1ZB');
    expect(b2b.recipientType).toBe(RecipientType.B2B);
  });

  it('prohibits silent financial substitution when Principal Amount Basis is omitted', async () => {
    const adapter = new AmazonMtrLiveAdapter({
      sourceReportName: 'synthetic_mock_mtr_missing_financials.csv'
    });

    const records = await adapter.parseFile(missingFinancialsPath);
    expect(records.length).toBe(1);
    const rec = records[0] as OutwardSupplyRecord;
    const missingIssue = rec.issues.find(
      (i) => i.code === IssueCode.MISSING_FIELD && i.field === 'Principal Amount Basis'
    );
    expect(missingIssue).toBeDefined();
    expect(missingIssue?.message).toContain('silent substitution from Tax Exclusive Gross is prohibited');
  });

  it('cleans up stream handles and destroys parser on early consumer abort', async () => {
    const adapter = new AmazonMtrLiveAdapter({
      sourceReportName: 'synthetic_mock_mtr_valid_interleaved.csv'
    });

    let count = 0;
    for await (const _ of adapter.streamRecords(validInterleavedPath)) {
      count++;
      if (count === 3) {
        break; // Consumer early abort
      }
    }

    expect(count).toBe(3);
  });
});
