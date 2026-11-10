import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { defaultOrchestrator } from '../../src/pipeline/pipeline-orchestrator.js';

const SUITE_ROOT = path.resolve(__dirname, '../../GSTFlow_Synthetic_Test_Suite');

const ALL_SYNTHETIC_FILES = [
  path.join(SUITE_ROOT, 'amazon/synthetic_amazon_mtr_b2b.csv'),
  path.join(SUITE_ROOT, 'amazon/synthetic_amazon_mtr_b2c.csv'),
  path.join(SUITE_ROOT, 'amazon/synthetic_amazon_stock_transfer.csv'),
  path.join(SUITE_ROOT, 'amazon/synthetic_amazon_credit_notes.csv'),
  path.join(SUITE_ROOT, 'edge_cases/synthetic_invalid_transactions.csv')
];

describe('PipelineOrchestrator - Full 18,500 Records Integration Suite', () => {
  it('processes all 18,500 records with zero data loss, exact reconciliation, and performance telemetry', async () => {
    const report = await defaultOrchestrator.processBatch(ALL_SYNTHETIC_FILES);

    // 1. Total records check against manifest
    expect(report.totalRecordsIngested).toBe(18500);

    // 2. Zero data loss check
    const sumOutcomes =
      report.outcomes.valid +
      report.outcomes.warning +
      report.outcomes.review +
      report.outcomes.error;

    expect(sumOutcomes).toBe(18500);
    expect(report.zeroDataLossVerified).toBe(true);

    // 3. Credit Note Reconciliation Verification
    // Exactly 2,000 credit notes: 675 B2B and 1,325 B2C
    expect(report.reconciliationSummary.totalCreditNotes).toBe(2000);
    expect(report.reconciliationSummary.matchedB2B).toBe(675);
    expect(report.reconciliationSummary.matchedB2C).toBe(1325);
    expect(report.reconciliationSummary.matchedFull + report.reconciliationSummary.matchedPartial).toBe(2000);
    expect(report.reconciliationSummary.unmatchedOrphan).toBe(0);
    expect(report.reconciliationSummary.valueExceeded).toBe(0);
    expect(report.reconciliationSummary.ambiguousMatches).toBe(0);

    // 4. Edge cases & error isolation check
    // 500 mutated records in synthetic_invalid_transactions.csv must be captured in outcomes
    expect(report.outcomes.error).toBeGreaterThanOrEqual(450); // 450 error-severity mutations + warnings
    expect(report.issuesBySeverity.errors).toBeGreaterThanOrEqual(500);

    // 5. Performance telemetry verification
    expect(report.performance.durationMs).toBeGreaterThan(0);
    expect(report.performance.recordsPerSecond).toBeGreaterThan(1000); // Expect > 1,000 rec/sec in Node v22

    console.log('\n================ FULL INTEGRATION TELEMETRY ================');
    console.log(`Total Records Ingested:    ${report.totalRecordsIngested}`);
    console.log(`  - VALID Outcomes:        ${report.outcomes.valid}`);
    console.log(`  - WARNING Outcomes:      ${report.outcomes.warning}`);
    console.log(`  - REVIEW Outcomes:       ${report.outcomes.review}`);
    console.log(`  - ERROR Outcomes:        ${report.outcomes.error}`);
    console.log(`Zero Data Loss Verified:   ${report.zeroDataLossVerified}`);
    console.log(`------------------------------------------------------------`);
    console.log(`Credit Notes Reconciled:   ${report.reconciliationSummary.totalCreditNotes}`);
    console.log(`  - Matched to B2B:        ${report.reconciliationSummary.matchedB2B}`);
    console.log(`  - Matched to B2C:        ${report.reconciliationSummary.matchedB2C}`);
    console.log(`  - Unmatched Orphans:     ${report.reconciliationSummary.unmatchedOrphan}`);
    console.log(`------------------------------------------------------------`);
    console.log(`Processing Time:           ${report.performance.durationMs} ms`);
    console.log(`Throughput:                ${report.performance.recordsPerSecond} records/sec`);
    console.log(`Start Heap:                ${report.performance.startMemoryHeapUsedMB} MB`);
    console.log(`Peak Heap:                 ${report.performance.peakMemoryHeapUsedMB} MB`);
    console.log('============================================================\n');
  });

  it('guarantees deterministic idempotency across repeated runs', async () => {
    // Run 1
    const rep1 = await defaultOrchestrator.processBatch(ALL_SYNTHETIC_FILES);
    // Run 2
    const rep2 = await defaultOrchestrator.processBatch(ALL_SYNTHETIC_FILES);

    expect(rep1.totalRecordsIngested).toBe(rep2.totalRecordsIngested);
    expect(rep1.outcomes.valid).toBe(rep2.outcomes.valid);
    expect(rep1.outcomes.warning).toBe(rep2.outcomes.warning);
    expect(rep1.outcomes.review).toBe(rep2.outcomes.review);
    expect(rep1.outcomes.error).toBe(rep2.outcomes.error);
    expect(rep1.reconciliationSummary.matchedB2B).toBe(rep2.reconciliationSummary.matchedB2B);
    expect(rep1.reconciliationSummary.matchedB2C).toBe(rep2.reconciliationSummary.matchedB2C);
  });
});
