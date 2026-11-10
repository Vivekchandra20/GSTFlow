import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { PipelineOrchestrator } from '../../src/pipeline/pipeline-orchestrator.js';
import { AmazonMtrLiveAdapter } from '../../src/adapters/amazon/amazon-live.adapter.js';

const FIXTURES_DIR = path.resolve(__dirname, '../fixtures/mock-amazon-live');

describe('AmazonMtrLiveAdapter - Pipeline Integration (Mock Harness)', () => {
  const validInterleavedPath = path.join(FIXTURES_DIR, 'synthetic_mock_mtr_valid_interleaved.csv');

  it('processes interleaved live MTR file through multi-pass pipeline with out-of-order credit note reconciliation', async () => {
    const orchestrator = new PipelineOrchestrator();

    const report = await orchestrator.processLiveBatch(
      [validInterleavedPath],
      (p) => new AmazonMtrLiveAdapter({ sourceReportName: 'synthetic_mock_mtr_valid_interleaved.csv' })
    );

    // 1. Ingestion count
    expect(report.totalRecordsIngested).toBe(10);
    expect(report.zeroDataLossVerified).toBe(true);

    // 2. Credit Note Reconciliation (Refund row 1 on line 2 reconciled against Shipment row 2 on line 3!)
    expect(report.reconciliationSummary.totalCreditNotes).toBe(2);
    expect(report.reconciliationSummary.matchedFull).toBe(1); // CN-LIVE-001 against INV-LIVE-001
    expect(report.reconciliationSummary.matchedPartial).toBe(1); // CN-LIVE-002 (₹200) against INV-LIVE-002 (₹500)
    expect(report.reconciliationSummary.unmatchedOrphan).toBe(0);

    // 3. Outcomes: All 10 records reach a definitive category
    const sumOutcomes =
      report.outcomes.valid + report.outcomes.warning + report.outcomes.review + report.outcomes.error;
    expect(sumOutcomes).toBe(10);

    // Row 7 (negative shipment) routes to review; Row 10 (DisputeReview) routes to error/malformed
    expect(report.outcomes.review).toBeGreaterThanOrEqual(1);
    expect(report.outcomes.error).toBeGreaterThanOrEqual(1);
  });

  it('guarantees deterministic idempotency across repeated batch executions', async () => {
    const orchestrator = new PipelineOrchestrator();

    const report1 = await orchestrator.processLiveBatch([validInterleavedPath]);
    const report2 = await orchestrator.processLiveBatch([validInterleavedPath]);

    expect(report1.totalRecordsIngested).toBe(report2.totalRecordsIngested);
    expect(report1.outcomes).toEqual(report2.outcomes);
    expect(report1.reconciliationSummary).toEqual(report2.reconciliationSummary);
  });
});
