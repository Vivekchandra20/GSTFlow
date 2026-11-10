import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { defaultAmazonAdapter } from '../../src/adapters/amazon/amazon-synthetic.adapter.js';
import { defaultNormalizer } from '../../src/engine/normalizer.js';
import { defaultRouter } from '../../src/engine/router.js';
import { DeduplicationEngine } from '../../src/engine/deduplicator.js';
import { defaultValidator, ValidationStatus } from '../../src/engine/validator.js';
import { IssueCode, IssueSeverity } from '../../src/models/enums.js';

const EDGE_CASES_FILE = path.resolve(
  __dirname,
  '../../GSTFlow_Synthetic_Test_Suite/edge_cases/synthetic_invalid_transactions.csv'
);

describe('Edge Cases Suite - All 500 Mutated Records Validation', () => {
  it('detects 100% of the 500 injected edge cases across all 10 defect categories', async () => {
    const deduplicator = new DeduplicationEngine();
    let totalProcessed = 0;
    const categoryDetections: Record<string, number> = {
      MISSING_BUYER_GSTIN: 0,
      DUPLICATE_INVOICE_NUMBER: 0,
      INVALID_INVOICE_DATE: 0,
      NEGATIVE_TAXABLE_VALUE: 0,
      TAX_MISMATCH: 0,
      MISSING_HSN: 0,
      INVALID_STATE_CODE: 0,
      MISSING_INVOICE_NUMBER: 0,
      B2B_WITHOUT_GSTIN: 0,
      INTERSTATE_WITH_CGST_SGST: 0
    };

    const categoryExpected: Record<string, number> = {
      MISSING_BUYER_GSTIN: 0,
      DUPLICATE_INVOICE_NUMBER: 0,
      INVALID_INVOICE_DATE: 0,
      NEGATIVE_TAXABLE_VALUE: 0,
      TAX_MISMATCH: 0,
      MISSING_HSN: 0,
      INVALID_STATE_CODE: 0,
      MISSING_INVOICE_NUMBER: 0,
      B2B_WITHOUT_GSTIN: 0,
      INTERSTATE_WITH_CGST_SGST: 0
    };

    for await (const rawRecord of defaultAmazonAdapter.streamRecords(EDGE_CASES_FILE)) {
      totalProcessed++;
      const expectedIssue = rawRecord.rawFields['Expected Issue'];
      if (expectedIssue && categoryExpected[expectedIssue] !== undefined) {
        categoryExpected[expectedIssue]++;
      }

      // Step 1: Normalization
      let record = defaultNormalizer.normalize(rawRecord);

      // Step 2: Deduplication (marketplace-level uniqueness)
      if (record.recordType === 'OUTWARD_SUPPLY') {
        record = deduplicator.processRecord(record, { scopeByFinancialYear: true, scopeBySeller: false });
      }

      // Step 3: Routing
      const routed = defaultRouter.route(record);
      record = routed.record;

      // Step 4: Validation Engine
      const report = defaultValidator.validate(record);

      // Verify that the record was not dropped and has issues
      expect(report.issues.length).toBeGreaterThan(0);

      // Verify detection of the specific expected issue
      const issueCodes = new Set(report.issues.map((i) => i.code));

      let matched = false;
      if (expectedIssue === 'MISSING_BUYER_GSTIN') {
        matched = issueCodes.has(IssueCode.B2B_WITHOUT_GSTIN) || issueCodes.has(IssueCode.MISSING_BUYER_GSTIN);
      } else if (expectedIssue === 'B2B_WITHOUT_GSTIN') {
        matched = issueCodes.has(IssueCode.B2B_WITHOUT_GSTIN) || issueCodes.has(IssueCode.MISSING_BUYER_GSTIN);
      } else if (expectedIssue === 'DUPLICATE_INVOICE_NUMBER') {
        matched = issueCodes.has(IssueCode.DUPLICATE_INVOICE_NUMBER);
      } else if (expectedIssue === 'INVALID_INVOICE_DATE') {
        matched = issueCodes.has(IssueCode.INVALID_INVOICE_DATE);
      } else if (expectedIssue === 'NEGATIVE_TAXABLE_VALUE') {
        matched = issueCodes.has(IssueCode.NEGATIVE_TAXABLE_VALUE);
      } else if (expectedIssue === 'TAX_MISMATCH') {
        matched = issueCodes.has(IssueCode.TAX_MISMATCH);
      } else if (expectedIssue === 'MISSING_HSN') {
        matched = issueCodes.has(IssueCode.MISSING_HSN);
      } else if (expectedIssue === 'INVALID_STATE_CODE') {
        matched = issueCodes.has(IssueCode.INVALID_STATE_CODE);
      } else if (expectedIssue === 'MISSING_INVOICE_NUMBER') {
        matched = issueCodes.has(IssueCode.MISSING_INVOICE_NUMBER);
      } else if (expectedIssue === 'INTERSTATE_WITH_CGST_SGST') {
        matched = issueCodes.has(IssueCode.INTERSTATE_WITH_CGST_SGST);
      }

      if (matched && expectedIssue) {
        categoryDetections[expectedIssue]++;
      } else {
        throw new Error(
          `Record ${rawRecord.sourceRowNumber} (${expectedIssue}) was not detected. Found issues: ${JSON.stringify(
            report.issues
          )}`
        );
      }

      // Verify exact source reference preservation
      expect(record.sourceRef.sourceReport).toBe('SYNTHETIC_AMAZON_MTR_B2B');
      expect(record.sourceRef.sourceRowNumber).toBe(rawRecord.sourceRowNumber);
    }

    expect(totalProcessed).toBe(500);

    // Verify 50 out of 50 for every category
    for (const [cat, count] of Object.entries(categoryDetections)) {
      expect(count).toBe(50);
      expect(categoryExpected[cat]).toBe(50);
    }
  });
});
