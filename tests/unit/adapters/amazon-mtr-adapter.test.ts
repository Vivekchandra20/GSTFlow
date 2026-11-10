import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { AmazonMtrLiveAdapter } from '../../../src/adapters/amazon/amazon-live.adapter.js';
import { HeaderAliasResolver } from '../../../src/adapters/amazon/amazon-live-header-resolver.js';
import {
  AmazonReportFormat,
  AmazonHeaderVersion,
  AmazonMtrMetadata
} from '../../../src/adapters/amazon/amazon-live.types.js';
import {
  OutwardSupplyRecord,
  CreditNoteRecord,
  StockTransferRecord,
  CancelledOrderRecord,
  MalformedRecord
} from '../../../src/models/transaction.schema.js';
import {
  RecipientType,
  SupplyType,
  IssueCode,
  IssueSeverity,
  StockTransferClassification,
  ReconciliationStatus
} from '../../../src/models/enums.js';
import { Decimal } from '../../../src/utils/decimal.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.resolve(__dirname, '../../fixtures/synthetic-mtr');

describe('Phase 5A: Amazon MTR Adapter & Synthetic Datasets Suite', () => {
  const datasetAPath = path.join(FIXTURES_DIR, 'dataset_a_b2b_shipments.csv');
  const datasetBPath = path.join(FIXTURES_DIR, 'dataset_b_b2c_shipments.csv');
  const datasetCPath = path.join(FIXTURES_DIR, 'dataset_c_refunds.csv');
  const datasetDPath = path.join(FIXTURES_DIR, 'dataset_d_shipping_giftwrap.csv');
  const datasetEPath = path.join(FIXTURES_DIR, 'dataset_e_historical_formats.csv');
  const datasetFPath = path.join(FIXTURES_DIR, 'dataset_f_invalid_records.csv');
  const datasetGPath = path.join(FIXTURES_DIR, 'dataset_g_stock_transfers_tcs.csv');

  describe('Report Format & Version Detection', () => {
    it('detects MTR_B2B and V2021_POST_FEB on current B2B report', () => {
      const resolver = new HeaderAliasResolver();
      resolver.mapHeaderRow([
        'Seller GSTIN', 'Invoice Number', 'Invoice Date', 'Transaction Type', 'Order ID',
        'Customer Bill to GSTIN', 'Principal Amount Basis'
      ]);

      expect(resolver.getReportFormat()).toBe(AmazonReportFormat.MTR_B2B);
      expect(resolver.getHeaderVersion()).toBe(AmazonHeaderVersion.V2021_POST_FEB);
      expect(resolver.getUnknownHeaders().length).toBe(0);
    });

    it('detects MTR_B2B and V2021_PRE_FEB on historical pre-2021 report with Customer Ship to GSTIN', () => {
      const resolver = new HeaderAliasResolver();
      resolver.mapHeaderRow([
        'Seller GSTIN', 'Invoice Number', 'Invoice Date', 'Transaction Type', 'Order ID',
        'Customer Ship to GSTIN', 'Principal Amount Basis'
      ]);

      expect(resolver.getReportFormat()).toBe(AmazonReportFormat.MTR_B2B);
      expect(resolver.getHeaderVersion()).toBe(AmazonHeaderVersion.V2021_PRE_FEB);
    });

    it('detects STOCK_TRANSFER and STR_V1 on Stock Transfer Report schema', () => {
      const resolver = new HeaderAliasResolver();
      resolver.mapHeaderRow([
        'Gstin Of Supplier', 'Invoice Number', 'Invoice Date', 'Transaction Type', 'Order ID',
        'Gstin Of Receiver', 'Ship From Fc', 'Ship To Fc'
      ]);

      expect(resolver.getReportFormat()).toBe(AmazonReportFormat.STOCK_TRANSFER);
      expect(resolver.getHeaderVersion()).toBe(AmazonHeaderVersion.STR_V1);
    });

    it('tracks unknown/unmapped columns without failing', () => {
      const resolver = new HeaderAliasResolver();
      const mapped = resolver.mapHeaderRow([
        'Seller GSTIN', 'Invoice Number', 'Invoice Date', 'Transaction Type', 'Order ID',
        'CustomSellerInternalTag', 'ArbitraryMetadataField'
      ]);

      expect(resolver.getUnknownHeaders()).toEqual([
        'CustomSellerInternalTag', 'ArbitraryMetadataField'
      ]);
      expect(mapped).toContain('sellerGstin');
      expect(mapped).toContain('CustomSellerInternalTag');
    });
  });

  describe('Dataset A — B2B Forward Shipments', () => {
    it('correctly parses B2B shipments, multi-line invoices, and Section 10(1)(b) POS', async () => {
      const adapter = new AmazonMtrLiveAdapter({
        sourceReportName: 'dataset_a_b2b_shipments.csv'
      });

      const records = await adapter.parseFile(datasetAPath);
      expect(records.length).toBe(6);

      // Verify all are OutwardSupplyRecord with B2B RecipientType
      records.forEach((r) => {
        expect(r.recordType).toBe('OUTWARD_SUPPLY');
        const outward = r as OutwardSupplyRecord;
        expect(outward.recipientType).toBe(RecipientType.B2B);
        expect(outward.customerGstin).toBeDefined();
      });

      // Verify Row 1: Intrastate supply in Maharashtra (27 -> 27)
      const row1 = records[0] as OutwardSupplyRecord;
      expect(row1.invoiceNumber).toBe('INV-B2B-001');
      expect(row1.sellerGstin).toBe('27AAPFU0939F1ZV');
      expect(row1.shipFromStateCode).toBe('27');
      expect(row1.placeOfSupplyStateCode).toBe('27');
      expect(row1.supplyType).toBe(SupplyType.INTRASTATE);
      expect(row1.taxBreakdown.cgstAmount.toNumber()).toBe(189.0);
      expect(row1.taxBreakdown.sgstAmount.toNumber()).toBe(189.0);
      expect(row1.taxBreakdown.igstAmount.toNumber()).toBe(0.0);

      // Verify Row 2: Interstate supply from MH to DL (27 -> 07)
      const row2 = records[1] as OutwardSupplyRecord;
      expect(row2.invoiceNumber).toBe('INV-B2B-002');
      expect(row2.shipFromStateCode).toBe('27');
      expect(row2.placeOfSupplyStateCode).toBe('07');
      expect(row2.supplyType).toBe(SupplyType.INTERSTATE);
      expect(row2.taxBreakdown.igstAmount.toNumber()).toBe(504.0);

      // Verify Rows 3 & 4: Section 10(1)(b) Bill-to vs Ship-to
      // Supplier in MH (27), Shipped to KA (29), but Buyer registered in MH (27)
      // Under Section 10(1)(b), POS is buyer principal place of business (27) -> INTRASTATE!
      const row3 = records[2] as OutwardSupplyRecord;
      const row4 = records[3] as OutwardSupplyRecord;
      expect(row3.invoiceNumber).toBe('INV-B2B-003');
      expect(row4.invoiceNumber).toBe('INV-B2B-003');
      expect(row3.placeOfSupplyStateCode).toBe('27');
      expect(row3.supplyType).toBe(SupplyType.INTRASTATE);
      expect(row3.taxBreakdown.cgstAmount.toNumber()).toBe(139.5);
      expect(row3.taxBreakdown.sgstAmount.toNumber()).toBe(139.5);

      // Multi-line invoice lines have different SKUs and prices
      expect(row3.sku).toBe('SKU-B2B-3');
      expect(row4.sku).toBe('SKU-B2B-4');
    });

    it('detects seller GSTIN mismatch when expectedSellerGstin is specified', async () => {
      const adapter = new AmazonMtrLiveAdapter({
        sourceReportName: 'dataset_a_b2b_shipments.csv',
        expectedSellerGstin: '27AAPFU0939F1ZV' // Org is registered in Maharashtra
      });

      const records = await adapter.parseFile(datasetAPath);
      // Rows 5 and 6 belong to Karnataka seller '29AABCU9603R1ZJ'
      const row5 = records[4] as OutwardSupplyRecord;
      const mismatchIssue = row5.issues.find((i) => i.code === IssueCode.BUYER_GSTIN_MISMATCH);
      expect(mismatchIssue).toBeDefined();
      expect(mismatchIssue?.severity).toBe(IssueSeverity.REVIEW);
    });
  });

  describe('Dataset B — B2C Retail Supplies', () => {
    it('applies statutory Section 10(1)(a) and 10(1)(ca) Place of Supply rules', async () => {
      const adapter = new AmazonMtrLiveAdapter({
        sourceReportName: 'dataset_b_b2c_shipments.csv'
      });

      const records = await adapter.parseFile(datasetBPath);
      expect(records.length).toBe(5);

      records.forEach((r) => {
        expect(r.recordType).toBe('OUTWARD_SUPPLY');
        const outward = r as OutwardSupplyRecord;
        expect(outward.recipientType).toBe(RecipientType.B2C);
        expect(outward.customerGstin).toBeUndefined();
      });

      // Row 1 (2023-05-15, pre-Oct 2023): Section 10(1)(a) delivery destination (MH 27)
      const row1 = records[0] as OutwardSupplyRecord;
      expect(row1.placeOfSupplyStateCode).toBe('27');

      // Row 4 (2026-10-10, post-Oct 2023): Ship-to state is missing;
      // Circular 209/03/2024-GST specifies fallback to supplier state (MH 27)
      const row4 = records[3] as OutwardSupplyRecord;
      expect(row4.placeOfSupplyStateCode).toBe('27');
      expect(row4.supplyType).toBe(SupplyType.INTRASTATE);
    });
  });

  describe('Dataset C — Credit Notes & Returns', () => {
    it('handles full refunds, partial refunds, multiple refunds, and orphan credit notes with three-tier precision', async () => {
      const adapter = new AmazonMtrLiveAdapter({
        sourceReportName: 'dataset_c_refunds.csv'
      });

      const records = await adapter.parseFile(datasetCPath);
      expect(records.length).toBe(6);

      // Row 2: Full Refund against INV-REF-ORIG-001
      const refund1 = records[1] as CreditNoteRecord;
      expect(refund1.recordType).toBe('CREDIT_NOTE');
      expect(refund1.creditNoteNumber).toBe('CN-SYN-FULL-001');
      expect(refund1.originalInvoiceNumber).toBe('INV-REF-ORIG-001');
      expect(refund1.taxableValueReversal.toNumber()).toBe(3000.0);
      expect(refund1.cgstAmountReversal.toNumber()).toBe(270.0);
      expect(refund1.sgstAmountReversal.toNumber()).toBe(270.0);

      // Verify three-tier amount in metadata preserves signed negative text
      const meta1 = refund1.sourceRef.rawRecord?._amazonMtrMetadata as AmazonMtrMetadata;
      expect(meta1.principalAmountBasis?.rawText).toBe('-3000.00');
      expect(meta1.principalAmountBasis?.signedAmount.toNumber()).toBe(-3000.0);
      expect(meta1.principalAmountBasis?.normalizedMagnitude.toNumber()).toBe(3000.0);

      // Row 4 & 5: Partial refunds against INV-REF-ORIG-002
      const refund2 = records[3] as CreditNoteRecord;
      const refund3 = records[4] as CreditNoteRecord;
      expect(refund2.creditNoteNumber).toBe('CN-SYN-PART-001');
      expect(refund2.originalInvoiceNumber).toBe('INV-REF-ORIG-002');
      expect(refund2.taxableValueReversal.toNumber()).toBe(2000.0);

      expect(refund3.creditNoteNumber).toBe('CN-SYN-PART-002');
      expect(refund3.originalInvoiceNumber).toBe('INV-REF-ORIG-002');
      expect(refund3.taxableValueReversal.toNumber()).toBe(1500.0);

      // Row 6: Orphan Credit Note with missing invoice number
      const orphan = records[5] as CreditNoteRecord;
      expect(orphan.creditNoteNumber).toBe('CN-SYN-ORPHAN-001');
      expect(orphan.originalInvoiceNumber).toBeUndefined();
      const orphanIssue = orphan.issues.find((i) => i.code === IssueCode.ORPHAN_CREDIT_NOTE);
      expect(orphanIssue).toBeDefined();
      expect(orphanIssue?.severity).toBe(IssueSeverity.REVIEW);
    });
  });

  describe('Dataset D — Composite Supplies & Promotional Discounts', () => {
    it('maps principal, shipping, gift wrap, and discounts into distinct breakdown components', async () => {
      const adapter = new AmazonMtrLiveAdapter({
        sourceReportName: 'dataset_d_shipping_giftwrap.csv'
      });

      const records = await adapter.parseFile(datasetDPath);
      expect(records.length).toBe(3);

      // Row 1: Principal ₹2000, Shipping ₹150, GiftWrap ₹50, ItemPromo ₹100, ShippingPromo ₹50
      // Net item = 2000 - 100 = 1900
      // Net shipping = 150 - 50 = 100
      // Total taxable = 2000
      const row1 = records[0] as OutwardSupplyRecord;
      expect(row1.taxBreakdown.taxableValue.toNumber()).toBe(1900.0);
      expect(row1.taxBreakdown.shippingTaxableValue?.toNumber()).toBe(100.0);

      const meta1 = row1.sourceRef.rawRecord?._amazonMtrMetadata as AmazonMtrMetadata;
      expect(meta1.giftWrapAmountBasis?.normalizedMagnitude.toNumber()).toBe(50.0);
      expect(meta1.itemPromoDiscountBasis?.normalizedMagnitude.toNumber()).toBe(100.0);
      expect(meta1.shippingPromoDiscountBasis?.normalizedMagnitude.toNumber()).toBe(50.0);
    });
  });

  describe('Dataset E — Historical Headers Compatibility', () => {
    it('seamlessly ingests pre-19 Feb 2021 schema containing Customer Ship to GSTIN', async () => {
      const adapter = new AmazonMtrLiveAdapter({
        sourceReportName: 'dataset_e_historical_formats.csv'
      });

      const records = await adapter.parseFile(datasetEPath);
      expect(records.length).toBe(3);

      const row1 = records[0] as OutwardSupplyRecord;
      expect(row1.customerGstin).toBe('29AABCT3518Q1ZV');
      expect(row1.recipientType).toBe(RecipientType.B2B);
      expect(row1.placeOfSupplyStateCode).toBe('29');
    });
  });

  describe('Dataset F — Invalid & Anomalous Records', () => {
    it('flags structured validation issues and classifies malformed rows deterministically', async () => {
      const adapter = new AmazonMtrLiveAdapter({
        sourceReportName: 'dataset_f_invalid_records.csv'
      });

      const records = await adapter.parseFile(datasetFPath);
      expect(records.length).toBe(8);

      // Row 1: Missing invoice number -> Error issue
      const row1 = records[0] as OutwardSupplyRecord;
      expect(row1.issues.some((i) => i.code === IssueCode.MISSING_INVOICE_NUMBER)).toBe(true);

      // Row 2: Invalid invoice date -> Error issue
      const row2 = records[1] as OutwardSupplyRecord;
      expect(row2.issues.some((i) => i.code === IssueCode.INVALID_INVOICE_DATE)).toBe(true);

      // Row 3: Missing Seller GSTIN -> Error issue
      const row3 = records[2] as OutwardSupplyRecord;
      expect(row3.issues.some((i) => i.code === IssueCode.MISSING_FIELD)).toBe(true);

      // Row 4: Unrecognized transaction type -> MALFORMED record
      const row4 = records[3] as MalformedRecord;
      expect(row4.recordType).toBe('MALFORMED');
      expect(row4.errorSummary).toContain('ArbitraryDispute');

      // Row 5: Negative shipment amount -> routes to Review
      const row5 = records[4] as OutwardSupplyRecord;
      expect(row5.issues.some((i) => i.code === IssueCode.NEGATIVE_TAXABLE_VALUE)).toBe(true);

      // Row 6: Intrastate with IGST -> routes to Review
      const row6 = records[5] as OutwardSupplyRecord;
      expect(row6.issues.some((i) => i.code === IssueCode.INTRASTATE_WITH_IGST)).toBe(true);

      // Row 7: Interstate with CGST/SGST -> routes to Review
      const row7 = records[6] as OutwardSupplyRecord;
      expect(row7.issues.some((i) => i.code === IssueCode.INTERSTATE_WITH_CGST_SGST)).toBe(true);

      // Row 8: Pre-dispatch cancel -> CANCELLED_ORDER record
      const row8 = records[7] as CancelledOrderRecord;
      expect(row8.recordType).toBe('CANCELLED_ORDER');
      expect(row8.createsTaxLiability).toBe(false);
    });
  });

  describe('Dataset G — Stock Transfers & Section 52 TCS', () => {
    it('normalizes 32-column Stock Transfer Report with Section 25(4) PAN matching and IRN metadata', async () => {
      const adapter = new AmazonMtrLiveAdapter({
        sourceReportName: 'dataset_g_stock_transfers_tcs.csv'
      });

      const records = await adapter.parseFile(datasetGPath);
      expect(records.length).toBe(4);

      // Row 1: FC_TRANSFER from BOM5 (MH) to BLR7 (KA) under same PAN (AAPFU0939F)
      // Classified as DISTINCT_PERSON_SUPPLY under Section 25(4) / Schedule I
      const row1 = records[0] as StockTransferRecord;
      expect(row1.recordType).toBe('STOCK_TRANSFER');
      expect(row1.transferInvoiceNumber).toBe('STR-BOM-BLR-001');
      expect(row1.sourceGstin).toBe('27AAPFU0939F1ZV');
      expect(row1.destinationGstin).toBe('29AAPFU0939F1ZU');
      expect(row1.sourcePan).toBe('AAPFU0939F');
      expect(row1.destinationPan).toBe('AAPFU0939F');
      expect(row1.classification).toBe(StockTransferClassification.DISTINCT_PERSON_SUPPLY);
      expect(row1.taxBreakdown.igstAmount.toNumber()).toBe(18000.0);

      // Verify IRN and TCS in metadata
      const meta1 = row1.sourceRef.rawRecord?._amazonMtrMetadata as AmazonMtrMetadata;
      expect(meta1.reportedTcsIgst?.normalizedMagnitude.toNumber()).toBe(250.0);

      // Row 3: FC_REMOVAL to seller premises in Delhi (07AAPFU0939F1ZX)
      // Distinct person inter-state removal under Section 25(4)
      const row3 = records[2] as StockTransferRecord;
      expect(row3.recordType).toBe('STOCK_TRANSFER');
      expect(row3.classification).toBe(StockTransferClassification.DISTINCT_PERSON_SUPPLY);

      // Row 4: Inter-company transfer with different PAN
      const row4 = records[3] as StockTransferRecord;
      expect(row4.recordType).toBe('STOCK_TRANSFER');
      expect(row4.classification).toBe(StockTransferClassification.INTER_COMPANY_SUPPLY);
    });
  });
});
