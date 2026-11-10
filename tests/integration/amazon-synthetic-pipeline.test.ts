import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach } from 'vitest';
import { PipelineOrchestrator } from '../../src/pipeline/pipeline-orchestrator.js';
import { AmazonMtrLiveAdapter } from '../../src/adapters/amazon/amazon-live.adapter.js';
import { StockTransferClassification } from '../../src/models/enums.js';
import {
  StockTransferProcessor,
  DefaultRegistrationRelationshipResolver
} from '../../src/engine/stock-transfer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.resolve(__dirname, '../fixtures/synthetic-mtr');

describe('Phase 5A: Amazon Synthetic Pipeline Integration Suite', () => {
  const datasetAPath = path.join(FIXTURES_DIR, 'dataset_a_b2b_shipments.csv');
  const datasetBPath = path.join(FIXTURES_DIR, 'dataset_b_b2c_shipments.csv');
  const datasetCPath = path.join(FIXTURES_DIR, 'dataset_c_refunds.csv');
  const datasetDPath = path.join(FIXTURES_DIR, 'dataset_d_shipping_giftwrap.csv');
  const datasetEPath = path.join(FIXTURES_DIR, 'dataset_e_historical_formats.csv');
  const datasetFPath = path.join(FIXTURES_DIR, 'dataset_f_invalid_records.csv');
  const datasetGPath = path.join(FIXTURES_DIR, 'dataset_g_stock_transfers_tcs.csv');

  let orchestrator: PipelineOrchestrator;

  beforeEach(() => {
    orchestrator = new PipelineOrchestrator();
  });

  it('preserves the four-outcome model (VALID + WARNING + REVIEW + ERROR = TOTAL) across all individual synthetic datasets', async () => {
    const allDatasets = [
      { name: 'Dataset A (B2B)', path: datasetAPath, expectedTotal: 6 },
      { name: 'Dataset B (B2C)', path: datasetBPath, expectedTotal: 5 },
      { name: 'Dataset C (Refunds)', path: datasetCPath, expectedTotal: 6 },
      { name: 'Dataset D (Composite/Promos)', path: datasetDPath, expectedTotal: 3 },
      { name: 'Dataset E (Historical)', path: datasetEPath, expectedTotal: 3 },
      { name: 'Dataset F (Invalid)', path: datasetFPath, expectedTotal: 8 },
      { name: 'Dataset G (Stock Transfers & TCS)', path: datasetGPath, expectedTotal: 4 }
    ];

    for (const ds of allDatasets) {
      const detailed = await orchestrator.processLiveBatchDetailed([ds.path], (p) =>
        new AmazonMtrLiveAdapter({ sourceReportName: path.basename(p) })
      );

      const report = detailed.report;
      expect(report.totalRecordsIngested, `Failed total for ${ds.name}`).toBe(ds.expectedTotal);
      expect(report.zeroDataLossVerified, `Zero data loss failed for ${ds.name}`).toBe(true);

      const sumOutcomes =
        report.outcomes.valid +
        report.outcomes.warning +
        report.outcomes.review +
        report.outcomes.error;
      expect(sumOutcomes, `Outcome sum mismatch for ${ds.name}`).toBe(ds.expectedTotal);
    }
  });

  it('processes combined multi-dataset batch with cross-file credit note reconciliation', async () => {
    // Ingest Dataset A (B2B shipments) and Dataset C (Refunds) together
    const detailed = await orchestrator.processLiveBatchDetailed(
      [datasetAPath, datasetCPath],
      (p) => new AmazonMtrLiveAdapter({ sourceReportName: path.basename(p) })
    );

    const report = detailed.report;
    const totalExpected = 6 + 6; // 6 from A + 6 from C
    expect(report.totalRecordsIngested).toBe(totalExpected);
    expect(report.zeroDataLossVerified).toBe(true);

    // Credit Note Reconciliation verification
    expect(report.reconciliationSummary.totalCreditNotes).toBe(4); // 4 credit notes in Dataset C
    expect(report.reconciliationSummary.matchedFull).toBe(1); // CN-SYN-FULL-001 matched against INV-REF-ORIG-001
    expect(report.reconciliationSummary.matchedPartial).toBe(2); // CN-SYN-PART-001 and CN-SYN-PART-002 matched against INV-REF-ORIG-002
    expect(report.reconciliationSummary.unmatchedOrphan).toBe(1); // CN-SYN-ORPHAN-001 has no original invoice

    // Outward invoices registered in invoice repository
    expect(detailed.invoices.size).toBeGreaterThan(0);
    expect(detailed.creditNotes.length).toBe(4);
  });

  it('correctly processes Section 8 composite supplies and Section 15(3)(a) discounts in Dataset D', async () => {
    const detailed = await orchestrator.processLiveBatchDetailed([datasetDPath], (p) =>
      new AmazonMtrLiveAdapter({ sourceReportName: path.basename(p) })
    );

    const report = detailed.report;
    expect(report.totalRecordsIngested).toBe(3);
    expect(report.zeroDataLossVerified).toBe(true);

    const invoices = Array.from(detailed.invoices.values());
    expect(invoices.length).toBe(3);

    // Row 1: Shipping and Gift Wrap ancillary supplies with promotional discounts
    // Taxable turnover: 2000 (item) - 100 (item promo) = 1900
    // Shipping turnover: 150 (shipping) - 50 (shipping promo) = 100
    const inv1 = invoices.find((inv) => inv.invoiceNumber === 'INV-COMPOSITE-001');
    expect(inv1).toBeDefined();
    expect(inv1?.totalTaxableValue.toNumber()).toBe(1900.0);
    expect(inv1?.shippingTaxableValue.toNumber()).toBe(100.0);
    expect(inv1?.totalInvoiceAmount.toNumber()).toBe(2419.0);

    // Row 2: Promotional discount on shipping only
    // Taxable turnover: 1600 - 0 = 1600
    // Shipping turnover: 200 - 100 = 100
    const inv2 = invoices.find((inv) => inv.invoiceNumber === 'INV-COMPOSITE-002');
    expect(inv2).toBeDefined();
    expect(inv2?.totalTaxableValue.toNumber()).toBe(1600.0);
    expect(inv2?.shippingTaxableValue.toNumber()).toBe(100.0);
    expect(inv2?.totalInvoiceAmount.toNumber()).toBe(2124.0);
  });

  it('correctly classifies stock transfers and retains IRN/TCS data in Dataset G', async () => {
    // 1. Default resolver: unverified same-PAN branch movement requires review (Rule GST-013)
    const detailed = await orchestrator.processLiveBatchDetailed([datasetGPath], (p) =>
      new AmazonMtrLiveAdapter({ sourceReportName: path.basename(p) })
    );

    const report = detailed.report;
    expect(report.totalRecordsIngested).toBe(4);
    expect(detailed.stockTransfers.length).toBe(4);

    const st1 = detailed.stockTransfers.find((st) => st.record.transferInvoiceNumber === 'STR-BOM-BLR-001');
    expect(st1).toBeDefined();
    expect(st1?.record.classification).toBe(StockTransferClassification.REVIEW_REQUIRED);
    expect(st1?.record.shipFromStateCode).toBe('27');
    expect(st1?.record.shipToStateCode).toBe('29');

    // Verify IRN and TCS are preserved on metadata
    const rawMeta1 = st1?.record.sourceRef.rawRecord?._amazonMtrMetadata;
    expect(rawMeta1?.irnNumber).toBe('3a7c645e9f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c');
    expect(rawMeta1?.irnStatus).toBe('GOVT_ACCEPT');

    // 2. Custom resolver with verified branch -> DISTINCT_PERSON_SUPPLY
    const relationshipResolver = new DefaultRegistrationRelationshipResolver();
    relationshipResolver.registerVerifiedBranch('27AAPFU0939F1ZV', '29AAPFU0939F1ZU');
    const customOrchestrator = new PipelineOrchestrator({
      stockTransferProcessor: new StockTransferProcessor(relationshipResolver)
    });

    const detailedVerified = await customOrchestrator.processLiveBatchDetailed([datasetGPath], (p) =>
      new AmazonMtrLiveAdapter({ sourceReportName: path.basename(p) })
    );

    const verifiedSt1 = detailedVerified.stockTransfers.find((st) => st.record.transferInvoiceNumber === 'STR-BOM-BLR-001');
    expect(verifiedSt1?.record.classification).toBe(StockTransferClassification.DISTINCT_PERSON_SUPPLY);
  });

  it('routes invalid, missing-header, and malformed records strictly to ERROR or REVIEW in Dataset F', async () => {
    const detailed = await orchestrator.processLiveBatchDetailed([datasetFPath], (p) =>
      new AmazonMtrLiveAdapter({ sourceReportName: path.basename(p) })
    );

    const report = detailed.report;
    expect(report.totalRecordsIngested).toBe(8);
    expect(report.zeroDataLossVerified).toBe(true);

    // Non-zero error/review count due to missing mandatory fields, invalid dates, and malformed rows
    expect(report.outcomes.error + report.outcomes.review).toBeGreaterThan(0);
    expect(report.issuesBySeverity.errors + report.issuesBySeverity.reviews).toBeGreaterThan(0);
  });

  it('guarantees strict deterministic idempotency across repeated batch executions', async () => {
    const fileBatch = [datasetAPath, datasetBPath, datasetCPath, datasetDPath];

    const result1 = await orchestrator.processLiveBatchDetailed(fileBatch, (p) =>
      new AmazonMtrLiveAdapter({ sourceReportName: path.basename(p) })
    );

    const result2 = await orchestrator.processLiveBatchDetailed(fileBatch, (p) =>
      new AmazonMtrLiveAdapter({ sourceReportName: path.basename(p) })
    );

    expect(result1.report.totalRecordsIngested).toBe(result2.report.totalRecordsIngested);
    expect(result1.report.outcomes).toEqual(result2.report.outcomes);
    expect(result1.report.reconciliationSummary).toEqual(result2.report.reconciliationSummary);
    expect(result1.invoices.size).toBe(result2.invoices.size);
    expect(result1.creditNotes.length).toBe(result2.creditNotes.length);
  });
});
