import { describe, it, expect, beforeEach } from 'vitest';
import { Decimal } from '../../src/utils/decimal.js';
import { ReconciliationEngine, InMemoryInvoiceRepository } from '../../src/engine/reconciler.js';
import { CreditNoteRecord, OutwardSupplyRecord } from '../../src/models/transaction.schema.js';
import { ReconciliationStatus, IssueCode, IssueSeverity, RecipientType, SupplyType } from '../../src/models/enums.js';

describe('ReconciliationEngine - Credit Note Matching & Cumulative Reversals', () => {
  let repo: InMemoryInvoiceRepository;
  let reconciler: ReconciliationEngine;

  beforeEach(() => {
    repo = new InMemoryInvoiceRepository();
    reconciler = new ReconciliationEngine(repo);
  });

  const createInvoice = (
    invoiceNumber: string,
    taxable: string,
    igst: string,
    customerGstin: string = '24ZZZYB0002F8Z5',
    sellerGstin: string = '27ZZZKA0001B3Z5',
    posState: string = '24'
  ): OutwardSupplyRecord => ({
    recordType: 'OUTWARD_SUPPLY',
    id: `inv-${invoiceNumber}`,
    sourceRef: { sourceReport: 'SYNTHETIC_AMAZON_MTR_B2B', sourceRowNumber: 1 },
    sellerGstin,
    customerGstin,
    invoiceNumber,
    invoiceDate: new Date('2026-04-10T00:00:00.000Z'),
    financialYear: '2026-2027',
    orderId: '408-0000001-0000013',
    quantity: 1,
    shipFromStateCode: '27',
    placeOfSupplyStateCode: posState,
    supplyType: SupplyType.INTERSTATE,
    recipientType: RecipientType.B2B,
    currency: 'INR',
    taxBreakdown: {
      taxableValue: new Decimal(taxable),
      shippingTaxableValue: new Decimal('0'),
      totalTaxableValue: new Decimal(taxable),
      taxRate: new Decimal('18'),
      cgstRate: new Decimal('0'),
      cgstAmount: new Decimal('0'),
      sgstRate: new Decimal('0'),
      sgstAmount: new Decimal('0'),
      utgstRate: new Decimal('0'),
      utgstAmount: new Decimal('0'),
      igstRate: new Decimal('18'),
      igstAmount: new Decimal(igst),
      cessAmount: new Decimal('0'),
      totalInvoiceAmount: new Decimal(taxable).add(new Decimal(igst))
    },
    issues: []
  });

  const createCreditNote = (
    cnNumber: string,
    origInvoiceNumber: string,
    taxableReversal: string,
    igstReversal: string,
    customerGstin: string = '24ZZZYB0002F8Z5',
    sellerGstin: string = '27ZZZKA0001B3Z5',
    posState: string = '24'
  ): CreditNoteRecord => ({
    recordType: 'CREDIT_NOTE',
    id: `cn-${cnNumber}`,
    sourceRef: { sourceReport: 'SYNTHETIC_AMAZON_CREDIT_NOTES', sourceRowNumber: 10 },
    creditNoteNumber: cnNumber,
    creditNoteDate: new Date('2026-05-01T00:00:00.000Z'),
    originalInvoiceNumber: origInvoiceNumber,
    originalInvoiceDate: new Date('2026-04-10T00:00:00.000Z'),
    financialYear: '2026-2027',
    orderId: '408-0000001-0000013',
    recipientType: RecipientType.B2B,
    sellerGstin,
    customerGstin,
    placeOfSupplyStateCode: posState,
    taxableValueReversal: new Decimal(taxableReversal),
    cgstAmountReversal: new Decimal('0'),
    sgstAmountReversal: new Decimal('0'),
    utgstAmountReversal: new Decimal('0'),
    igstAmountReversal: new Decimal(igstReversal),
    creditNoteTotal: new Decimal(taxableReversal).add(new Decimal(igstReversal)),
    reconciliationStatus: ReconciliationStatus.UNMATCHED_ORPHAN,
    issues: []
  });

  it('flags orphan credit note without matching original invoice reference (GST-010)', () => {
    // CN referencing non-existent invoice
    const cn = createCreditNote('CN/01', 'AMZ/NON_EXISTENT', '1000', '180');
    const result = reconciler.reconcileCreditNote(cn);

    expect(result.reconciliationStatus).toBe(ReconciliationStatus.UNMATCHED_ORPHAN);
    const orphanIssue = result.issues.find((i) => i.code === IssueCode.ORPHAN_CREDIT_NOTE);
    expect(orphanIssue).toBeDefined();
    expect(orphanIssue?.severity).toBe(IssueSeverity.WARNING);
  });

  it('matches partial reversal with sufficient evidence as MATCHED_PARTIAL (GST-014)', () => {
    // Original Invoice: ₹10,000 taxable, ₹1,800 IGST
    repo.registerInvoice(createInvoice('AMZ/26-27/0000001', '10000', '1800'));

    // Partial CN: ₹4,000 taxable (40% reversal)
    const cn = createCreditNote('CN/01', 'AMZ/26-27/0000001', '4000', '720');
    const result = reconciler.reconcileCreditNote(cn);

    expect(result.reconciliationStatus).toBe(ReconciliationStatus.MATCHED_PARTIAL);
    expect(result.matchedInvoiceNumber).toBe('AMZ/26-27/0000001');
    expect(result.issues.length).toBe(0);

    const invSummary = repo.getInvoiceSummary('27ZZZKA0001B3Z5', '2026-2027', 'AMZ/26-27/0000001');
    expect(invSummary?.cumulativeTaxableReversed.toString()).toBe('4000');
  });

  it('strictly enforces cumulative reversal limit on multiple credit notes: ₹4k + ₹3k + ₹4k against ₹10k', () => {
    // Original invoice: ₹10,000
    repo.registerInvoice(createInvoice('AMZ/26-27/0000002', '10000', '1800'));

    // CN 1: ₹4,000 -> cumulative ₹4,000 <= ₹10,000 -> MATCHED_PARTIAL
    const cn1 = createCreditNote('CN/01', 'AMZ/26-27/0000002', '4000', '720');
    const res1 = reconciler.reconcileCreditNote(cn1);
    expect(res1.reconciliationStatus).toBe(ReconciliationStatus.MATCHED_PARTIAL);

    // CN 2: ₹3,000 -> cumulative ₹7,000 <= ₹10,000 -> MATCHED_PARTIAL
    const cn2 = createCreditNote('CN/02', 'AMZ/26-27/0000002', '3000', '540');
    const res2 = reconciler.reconcileCreditNote(cn2);
    expect(res2.reconciliationStatus).toBe(ReconciliationStatus.MATCHED_PARTIAL);

    // CN 3: ₹4,000 -> cumulative ₹11,000 > ₹10,000 -> VALUE_EXCEEDED!
    const cn3 = createCreditNote('CN/03', 'AMZ/26-27/0000002', '4000', '720');
    const res3 = reconciler.reconcileCreditNote(cn3);
    expect(res3.reconciliationStatus).toBe(ReconciliationStatus.VALUE_EXCEEDED);

    const excessIssue = res3.issues.find((i) => i.code === IssueCode.CUMULATIVE_REVERSAL_EXCEEDED);
    expect(excessIssue).toBeDefined();
    expect(excessIssue?.severity).toBe(IssueSeverity.ERROR);
    expect(excessIssue?.message).toContain('exceeds original invoice taxable value ₹10000.00');

    // Confirm that invoice cumulative did not improperly record the 3rd exceeding CN
    const invSummary = repo.getInvoiceSummary('27ZZZKA0001B3Z5', '2026-2027', 'AMZ/26-27/0000002');
    expect(invSummary?.cumulativeTaxableReversed.toString()).toBe('7000');
  });

  it('prevents counting the same credit note twice upon duplicate ingestion', () => {
    repo.registerInvoice(createInvoice('AMZ/26-27/0000003', '5000', '900'));

    const cn = createCreditNote('CN/DUPE', 'AMZ/26-27/0000003', '1000', '180');
    reconciler.reconcileCreditNote(cn);

    // Reprocess same credit note
    const cnRepeat = createCreditNote('CN/DUPE', 'AMZ/26-27/0000003', '1000', '180');
    const resRepeat = reconciler.reconcileCreditNote(cnRepeat);

    const dupeIssue = resRepeat.issues.find((i) => i.code === IssueCode.DUPLICATE_LINE_ITEM);
    expect(dupeIssue).toBeDefined();
    expect(dupeIssue?.message).toContain('already been processed');
  });

  it('flags buyer GSTIN mismatch between credit note and original invoice', () => {
    repo.registerInvoice(createInvoice('AMZ/26-27/0000004', '5000', '900', '24ZZZYB0002F8Z5'));

    // CN has a conflicting buyer GSTIN
    const cn = createCreditNote('CN/05', 'AMZ/26-27/0000004', '1000', '180', '07ZZZYB0003F9Z5');
    const res = reconciler.reconcileCreditNote(cn);

    const buyerMismatch = res.issues.find((i) => i.code === IssueCode.BUYER_GSTIN_MISMATCH);
    expect(buyerMismatch).toBeDefined();
  });

  it('flags Place of Supply mismatch between credit note and original invoice', () => {
    repo.registerInvoice(createInvoice('AMZ/26-27/0000005', '5000', '900', '24ZZZYB0002F8Z5', '27ZZZKA0001B3Z5', '24'));

    // CN has conflicting Place of Supply state (07 vs 24)
    const cn = createCreditNote('CN/06', 'AMZ/26-27/0000005', '1000', '180', '24ZZZYB0002F8Z5', '27ZZZKA0001B3Z5', '07');
    const res = reconciler.reconcileCreditNote(cn);

    const posMismatch = res.issues.find((i) => i.code === IssueCode.POS_MISMATCH);
    expect(posMismatch).toBeDefined();
  });

  it('flags ambiguous matches when multiple candidate invoices match without disambiguation', () => {
    // Add two invoices sharing same number across different FYs (without CN date specification)
    const inv1 = createInvoice('AMZ/REPEAT_NO', '5000', '900');
    inv1.financialYear = '2025-2026';
    const inv2 = createInvoice('AMZ/REPEAT_NO', '5000', '900');
    inv2.financialYear = '2026-2027';

    repo.registerInvoice(inv1);
    repo.registerInvoice(inv2);

    // CN with undefined originalInvoiceDate
    const cn = createCreditNote('CN/AMBIGUOUS', 'AMZ/REPEAT_NO', '1000', '180');
    cn.originalInvoiceDate = undefined;

    const res = reconciler.reconcileCreditNote(cn);
    expect(res.reconciliationStatus).toBe(ReconciliationStatus.AMBIGUOUS_MATCH);
    const ambigIssue = res.issues.find((i) => i.code === IssueCode.AMBIGUOUS_CREDIT_NOTE_MATCH);
    expect(ambigIssue).toBeDefined();
  });
});
