import { describe, it, expect, beforeEach } from 'vitest';
import { Decimal } from '../../src/utils/decimal.js';
import {
  StockTransferProcessor,
  DefaultRegistrationRelationshipResolver
} from '../../src/engine/stock-transfer.js';
import { StockTransferRecord } from '../../src/models/transaction.schema.js';
import { StockTransferClassification, IssueCode, IssueSeverity } from '../../src/models/enums.js';

describe('StockTransferProcessor - Statutory Classification', () => {
  let resolver: DefaultRegistrationRelationshipResolver;
  let processor: StockTransferProcessor;

  beforeEach(() => {
    resolver = new DefaultRegistrationRelationshipResolver();
    processor = new StockTransferProcessor(resolver);
  });

  const createTransfer = (sourceGstin: string, destinationGstin: string): StockTransferRecord => ({
    recordType: 'STOCK_TRANSFER',
    id: 'st-01',
    sourceRef: { sourceReport: 'SYNTHETIC_AMAZON_STOCK_TRANSFER', sourceRowNumber: 2 },
    transferInvoiceNumber: 'ST/26-27/000001',
    transferDate: new Date('2026-04-24T00:00:00.000Z'),
    financialYear: '2026-2027',
    sourceGstin,
    destinationGstin,
    sourcePan: '',
    destinationPan: '',
    classification: StockTransferClassification.UNKNOWN,
    shipFromStateCode: sourceGstin.slice(0, 2),
    shipToStateCode: destinationGstin.slice(0, 2),
    quantity: 1,
    taxBreakdown: {
      taxableValue: new Decimal('10000'),
      shippingTaxableValue: new Decimal('0'),
      totalTaxableValue: new Decimal('10000'),
      taxRate: new Decimal('18'),
      cgstRate: new Decimal('0'),
      cgstAmount: new Decimal('0'),
      sgstRate: new Decimal('0'),
      sgstAmount: new Decimal('0'),
      utgstRate: new Decimal('0'),
      utgstAmount: new Decimal('0'),
      igstRate: new Decimal('18'),
      igstAmount: new Decimal('1800'),
      cessAmount: new Decimal('0'),
      totalInvoiceAmount: new Decimal('11800')
    },
    issues: []
  });

  it('classifies verified branch registrations as DISTINCT_PERSON_SUPPLY under Section 25(4)/(5) (GST-013)', () => {
    // Same PAN: ZZZCD0001I
    const srcGstin = '09ZZZCD0001I1Z5'; // Uttar Pradesh
    const destGstin = '36ZZZCD0001I1Z5'; // Telangana
    resolver.registerVerifiedBranch(srcGstin, destGstin);

    const record = createTransfer(srcGstin, destGstin);
    const classified = processor.classifyTransfer(record);

    expect(classified.classification).toBe(StockTransferClassification.DISTINCT_PERSON_SUPPLY);
    expect(classified.sourcePan).toBe('ZZZCD0001I');
    expect(classified.destinationPan).toBe('ZZZCD0001I');
    expect(classified.issues.length).toBe(0);
  });

  it('classifies same PAN across different states as REVIEW_REQUIRED when unverified in master data', () => {
    // Same PAN: ZZZCD0001I, but NOT registered in verifiedBranchPairs
    const srcGstin = '09ZZZCD0001I1Z5';
    const destGstin = '36ZZZCD0001I1Z5';

    const record = createTransfer(srcGstin, destGstin);
    const classified = processor.classifyTransfer(record);

    expect(classified.classification).toBe(StockTransferClassification.REVIEW_REQUIRED);
    const reviewIssue = classified.issues.find((i) => i.code === IssueCode.STOCK_TRANSFER_REVIEW_REQUIRED);
    expect(reviewIssue).toBeDefined();
    expect(reviewIssue?.severity).toBe(IssueSeverity.REVIEW);
    expect(reviewIssue?.message).toContain('branch relationship requires verification');
  });

  it('flags intra-unit movement where source and destination GSTIN are identical', () => {
    const gstin = '09ZZZCD0001I1Z5';
    const record = createTransfer(gstin, gstin);
    const classified = processor.classifyTransfer(record);

    expect(classified.classification).toBe(StockTransferClassification.REVIEW_REQUIRED);
    const issue = classified.issues.find((i) => i.code === IssueCode.STOCK_TRANSFER_REVIEW_REQUIRED);
    expect(issue?.message).toContain('source and destination GSTIN are identical');
  });

  it('classifies confirmed related entities under Section 15 explanation as RELATED_PERSON_SUPPLY', () => {
    // PAN A: ZZZCD0001I, PAN B: ZZZMD0001J
    const srcGstin = '09ZZZCD0001I1Z5';
    const destGstin = '36ZZZMD0001J2Z5';
    resolver.registerRelatedEntity('ZZZCD0001I', 'ZZZMD0001J');

    const record = createTransfer(srcGstin, destGstin);
    const classified = processor.classifyTransfer(record);

    expect(classified.classification).toBe(StockTransferClassification.RELATED_PERSON_SUPPLY);
  });

  it('classifies different PAN entities without established relationship as INTER_COMPANY_SUPPLY', () => {
    // PAN A: ZZZCD0001I, PAN B: ZZZMD0001J (Unrelated third parties)
    const srcGstin = '09ZZZCD0001I1Z5';
    const destGstin = '36ZZZMD0001J2Z5';

    const record = createTransfer(srcGstin, destGstin);
    const classified = processor.classifyTransfer(record);

    expect(classified.classification).toBe(StockTransferClassification.INTER_COMPANY_SUPPLY);
  });

  it('classifies malformed GSTIN inputs as UNKNOWN with error', () => {
    const record = createTransfer('INVALID_SRC', 'INVALID_DEST');
    const classified = processor.classifyTransfer(record);

    expect(classified.classification).toBe(StockTransferClassification.UNKNOWN);
    expect(classified.issues.some((i) => i.severity === IssueSeverity.ERROR)).toBe(true);
  });
});
