import { Decimal, roundToTwo } from '../utils/decimal.js';
import { CreditNoteRecord, OutwardSupplyRecord, ValidationIssue } from '../models/transaction.schema.js';
import { ReconciliationStatus, IssueCode, IssueSeverity, RecipientType } from '../models/enums.js';
import { getFinancialYear } from '../utils/date.js';

export interface ReconciledInvoiceSummary {
  sellerGstin: string;
  financialYear: string;
  invoiceNumber: string;
  invoiceDate?: Date;
  customerGstin?: string;
  placeOfSupplyStateCode: string;
  totalTaxableValue: Decimal;
  cgstAmount: Decimal;
  sgstAmount: Decimal;
  utgstAmount: Decimal;
  igstAmount: Decimal;
  cessAmount: Decimal;
  totalInvoiceAmount: Decimal;
  cumulativeTaxableReversed: Decimal;
  cumulativeCgstReversed: Decimal;
  cumulativeSgstReversed: Decimal;
  cumulativeUtgstReversed: Decimal;
  cumulativeIgstReversed: Decimal;
  cumulativeTotalReversed: Decimal;
  appliedCreditNotes: string[]; // Set of credit note numbers
}

export interface IInvoiceRepository {
  registerInvoice(invoice: OutwardSupplyRecord): void;
  findCandidates(sellerGstin: string, originalInvoiceNumber: string, financialYear?: string): ReconciledInvoiceSummary[];
  getInvoiceSummary(sellerGstin: string, financialYear: string, invoiceNumber: string): ReconciledInvoiceSummary | undefined;
  reset(): void;
}

export class InMemoryInvoiceRepository implements IInvoiceRepository {
  // Keyed by `${sellerGstin}#${financialYear}#${invoiceNumber}`
  private invoices = new Map<string, ReconciledInvoiceSummary>();

  public reset(): void {
    this.invoices.clear();
  }

  public registerInvoice(record: OutwardSupplyRecord): void {
    const key = `${record.sellerGstin}#${record.financialYear}#${record.invoiceNumber}`;
    const existing = this.invoices.get(key);

    if (!existing) {
      this.invoices.set(key, {
        sellerGstin: record.sellerGstin,
        financialYear: record.financialYear,
        invoiceNumber: record.invoiceNumber,
        invoiceDate: record.invoiceDate,
        customerGstin: record.customerGstin,
        placeOfSupplyStateCode: record.placeOfSupplyStateCode,
        totalTaxableValue: record.taxBreakdown.totalTaxableValue,
        cgstAmount: record.taxBreakdown.cgstAmount,
        sgstAmount: record.taxBreakdown.sgstAmount,
        utgstAmount: record.taxBreakdown.utgstAmount,
        igstAmount: record.taxBreakdown.igstAmount,
        cessAmount: record.taxBreakdown.cessAmount,
        totalInvoiceAmount: record.taxBreakdown.totalInvoiceAmount,
        cumulativeTaxableReversed: new Decimal(0),
        cumulativeCgstReversed: new Decimal(0),
        cumulativeSgstReversed: new Decimal(0),
        cumulativeUtgstReversed: new Decimal(0),
        cumulativeIgstReversed: new Decimal(0),
        cumulativeTotalReversed: new Decimal(0),
        appliedCreditNotes: []
      });
    } else {
      // Accumulate multi-line items of the same invoice
      existing.totalTaxableValue = existing.totalTaxableValue.add(record.taxBreakdown.totalTaxableValue);
      existing.cgstAmount = existing.cgstAmount.add(record.taxBreakdown.cgstAmount);
      existing.sgstAmount = existing.sgstAmount.add(record.taxBreakdown.sgstAmount);
      existing.utgstAmount = existing.utgstAmount.add(record.taxBreakdown.utgstAmount);
      existing.igstAmount = existing.igstAmount.add(record.taxBreakdown.igstAmount);
      existing.cessAmount = existing.cessAmount.add(record.taxBreakdown.cessAmount);
      existing.totalInvoiceAmount = existing.totalInvoiceAmount.add(record.taxBreakdown.totalInvoiceAmount);
    }
  }

  public findCandidates(sellerGstin: string, originalInvoiceNumber: string, financialYear?: string): ReconciledInvoiceSummary[] {
    const candidates: ReconciledInvoiceSummary[] = [];
    const normalizedSeller = sellerGstin.trim().toUpperCase();
    const normalizedInvoice = originalInvoiceNumber.trim();

    for (const [key, summary] of this.invoices.entries()) {
      if (summary.sellerGstin === normalizedSeller && summary.invoiceNumber === normalizedInvoice) {
        if (!financialYear || summary.financialYear === financialYear) {
          candidates.push(summary);
        }
      }
    }
    return candidates;
  }

  public getInvoiceSummary(sellerGstin: string, financialYear: string, invoiceNumber: string): ReconciledInvoiceSummary | undefined {
    return this.invoices.get(`${sellerGstin.trim().toUpperCase()}#${financialYear}#${invoiceNumber.trim()}`);
  }
}

export class ReconciliationEngine {
  private repo: IInvoiceRepository;
  private tolerance: Decimal;

  constructor(repo: IInvoiceRepository = new InMemoryInvoiceRepository(), tolerance: Decimal = new Decimal('0.02')) {
    this.repo = repo;
    this.tolerance = tolerance;
  }

  public getRepository(): IInvoiceRepository {
    return this.repo;
  }

  /**
   * Reconciles a CreditNoteRecord against the registered invoice repository.
   * Modifies credit note reconciliationStatus and issues in-place, and updates cumulative reversal state.
   */
  public reconcileCreditNote(cn: CreditNoteRecord): CreditNoteRecord {
    const sellerGstin = cn.sellerGstin ? cn.sellerGstin.trim().toUpperCase() : '';
    const origInvoiceNumber = cn.originalInvoiceNumber ? cn.originalInvoiceNumber.trim() : '';

    // Check if original invoice reference is provided (GST-010)
    if (!origInvoiceNumber) {
      cn.reconciliationStatus = ReconciliationStatus.UNMATCHED_ORPHAN;
      cn.issues.push({
        code: IssueCode.ORPHAN_CREDIT_NOTE,
        severity: IssueSeverity.WARNING,
        field: 'Original Invoice Number',
        message: 'Credit note has missing original invoice reference (GST-010); routed to review',
        sourceRowNumber: cn.sourceRef.sourceRowNumber,
        sourceReport: cn.sourceRef.sourceReport
      });
      return cn;
    }

    // Determine target financial year for matching if original invoice date is available
    const targetFY = cn.originalInvoiceDate ? getFinancialYear(cn.originalInvoiceDate) : undefined;
    const candidates = this.repo.findCandidates(sellerGstin, origInvoiceNumber, targetFY);

    // 1. Orphan check
    if (candidates.length === 0) {
      cn.reconciliationStatus = ReconciliationStatus.UNMATCHED_ORPHAN;
      cn.issues.push({
        code: IssueCode.ORPHAN_CREDIT_NOTE,
        severity: IssueSeverity.WARNING,
        field: 'Original Invoice Number',
        message: `Original invoice '${origInvoiceNumber}' not found for seller ${sellerGstin} (GST-010); preserved for review`,
        sourceRowNumber: cn.sourceRef.sourceRowNumber,
        sourceReport: cn.sourceRef.sourceReport
      });
      return cn;
    }

    // 2. Ambiguity check
    if (candidates.length > 1) {
      cn.reconciliationStatus = ReconciliationStatus.AMBIGUOUS_MATCH;
      cn.issues.push({
        code: IssueCode.AMBIGUOUS_CREDIT_NOTE_MATCH,
        severity: IssueSeverity.ERROR,
        field: 'Original Invoice Number',
        message: `Multiple candidate invoices (${candidates.length}) match original invoice number '${origInvoiceNumber}'; manual reconciliation required`,
        sourceRowNumber: cn.sourceRef.sourceRowNumber,
        sourceReport: cn.sourceRef.sourceReport
      });
      return cn;
    }

    const matchedInvoice = candidates[0];

    // 3. Repeated ingestion check (prevent counting the same CN twice)
    if (matchedInvoice.appliedCreditNotes.includes(cn.creditNoteNumber)) {
      cn.issues.push({
        code: IssueCode.DUPLICATE_LINE_ITEM,
        severity: IssueSeverity.ERROR,
        field: 'Credit Note Number',
        message: `Credit note '${cn.creditNoteNumber}' has already been processed against invoice '${origInvoiceNumber}'`,
        sourceRowNumber: cn.sourceRef.sourceRowNumber,
        sourceReport: cn.sourceRef.sourceReport
      });
      return cn;
    }

    // 4. Supporting evidence check: Buyer GSTIN parity on B2B
    if (cn.recipientType === RecipientType.B2B && cn.customerGstin && matchedInvoice.customerGstin) {
      if (cn.customerGstin.trim().toUpperCase() !== matchedInvoice.customerGstin.trim().toUpperCase()) {
        cn.issues.push({
          code: IssueCode.BUYER_GSTIN_MISMATCH,
          severity: IssueSeverity.ERROR,
          field: 'Customer Bill To GSTIN',
          message: `Credit note recipient GSTIN (${cn.customerGstin}) conflicts with original invoice buyer (${matchedInvoice.customerGstin})`,
          sourceRowNumber: cn.sourceRef.sourceRowNumber,
          sourceReport: cn.sourceRef.sourceReport
        });
      }
    }

    // 5. Supporting evidence check: Place of supply parity
    if (cn.placeOfSupplyStateCode && matchedInvoice.placeOfSupplyStateCode) {
      if (cn.placeOfSupplyStateCode.trim() !== matchedInvoice.placeOfSupplyStateCode.trim()) {
        cn.issues.push({
          code: IssueCode.POS_MISMATCH,
          severity: IssueSeverity.ERROR,
          field: 'Place of Supply State Code',
          message: `Credit note Place of Supply (${cn.placeOfSupplyStateCode}) conflicts with original invoice (${matchedInvoice.placeOfSupplyStateCode})`,
          sourceRowNumber: cn.sourceRef.sourceRowNumber,
          sourceReport: cn.sourceRef.sourceReport
        });
      }
    }

    // 6. Tax component jurisdiction consistency
    if (matchedInvoice.igstAmount.gt(0) && (cn.cgstAmountReversal.gt(0) || cn.sgstAmountReversal.gt(0))) {
      cn.reconciliationStatus = ReconciliationStatus.JURISDICTION_MISMATCH;
      cn.issues.push({
        code: IssueCode.INTERSTATE_WITH_CGST_SGST,
        severity: IssueSeverity.ERROR,
        field: 'Tax Components',
        message: `Original invoice is Interstate with IGST, but credit note reverses CGST/SGST`,
        sourceRowNumber: cn.sourceRef.sourceRowNumber,
        sourceReport: cn.sourceRef.sourceReport
      });
      return cn;
    }

    // 7. Cumulative Reversal Threshold Check
    const newCumulativeTaxable = matchedInvoice.cumulativeTaxableReversed.add(cn.taxableValueReversal);
    const newCumulativeTotal = matchedInvoice.cumulativeTotalReversed.add(cn.creditNoteTotal);

    if (newCumulativeTaxable.gt(matchedInvoice.totalTaxableValue.add(this.tolerance))) {
      cn.reconciliationStatus = ReconciliationStatus.VALUE_EXCEEDED;
      cn.issues.push({
        code: IssueCode.CUMULATIVE_REVERSAL_EXCEEDED,
        severity: IssueSeverity.ERROR,
        field: 'Taxable Value Reversal',
        message: `Cumulative taxable reversal ₹${newCumulativeTaxable.toFixed(2)} exceeds original invoice taxable value ₹${matchedInvoice.totalTaxableValue.toFixed(2)} (Previous reversals: ₹${matchedInvoice.cumulativeTaxableReversed.toFixed(2)}, Current CN: ₹${cn.taxableValueReversal.toFixed(2)})`,
        sourceRowNumber: cn.sourceRef.sourceRowNumber,
        sourceReport: cn.sourceRef.sourceReport
      });
      return cn;
    }

    // 8. Successful match (GST-014: Partial or Full Reversal)
    const isFull = newCumulativeTaxable.gte(matchedInvoice.totalTaxableValue.sub(this.tolerance));
    cn.reconciliationStatus = isFull ? ReconciliationStatus.MATCHED_FULL : ReconciliationStatus.MATCHED_PARTIAL;
    cn.matchedInvoiceNumber = matchedInvoice.invoiceNumber;

    // Update cumulative state on the invoice
    matchedInvoice.cumulativeTaxableReversed = newCumulativeTaxable;
    matchedInvoice.cumulativeCgstReversed = matchedInvoice.cumulativeCgstReversed.add(cn.cgstAmountReversal);
    matchedInvoice.cumulativeSgstReversed = matchedInvoice.cumulativeSgstReversed.add(cn.sgstAmountReversal);
    matchedInvoice.cumulativeUtgstReversed = matchedInvoice.cumulativeUtgstReversed.add(cn.utgstAmountReversal);
    matchedInvoice.cumulativeIgstReversed = matchedInvoice.cumulativeIgstReversed.add(cn.igstAmountReversal);
    matchedInvoice.cumulativeTotalReversed = newCumulativeTotal;
    matchedInvoice.appliedCreditNotes.push(cn.creditNoteNumber);

    return cn;
  }
}

export const defaultReconciler = new ReconciliationEngine();
