import {
  NormalizedRecord,
  OutwardSupplyRecord,
  CreditNoteRecord,
  StockTransferRecord,
  ValidationIssue
} from '../models/transaction.schema.js';
import {
  IssueCode,
  IssueSeverity,
  RecipientType,
  SupplyType,
  ReconciliationStatus,
  StockTransferClassification
} from '../models/enums.js';
import { defaultTaxRateCatalogue, TaxRateCatalogue } from '../models/tax-catalogue.js';
import { isValidStateCode, isUTGSTApplicable } from '../utils/state-codes.js';
import { GSTCalculator, CalculationPolicy, DEFAULT_CALCULATION_POLICY } from './gst-calculator.js';

export enum ValidationStatus {
  VALID = 'VALID',
  WARNING = 'WARNING',
  REVIEW = 'REVIEW',
  ERROR = 'ERROR'
}

export interface ValidationReport {
  recordId: string;
  documentId?: string;
  recordType: string;
  status: ValidationStatus;
  errorsCount: number;
  warningsCount: number;
  reviewCount: number;
  issues: ValidationIssue[];
}

export interface ValidationEngineOptions {
  catalogue?: TaxRateCatalogue;
  policy?: CalculationPolicy;
}

export class ValidationEngine {
  private catalogue: TaxRateCatalogue;
  private policy: CalculationPolicy;

  constructor(options: ValidationEngineOptions = {}) {
    this.catalogue = options.catalogue || defaultTaxRateCatalogue;
    this.policy = options.policy || DEFAULT_CALCULATION_POLICY;
  }

  /**
   * Consolidates and executes deterministic GST validation rules across normalized records.
   * Covers GST-001 through GST-015 and injected edge case categories.
   */
  public validate(record: NormalizedRecord): ValidationReport {
    // 1. Run rule validations according to record type
    if (record.recordType === 'OUTWARD_SUPPLY') {
      this.validateOutwardSupply(record);
    } else if (record.recordType === 'CREDIT_NOTE') {
      this.validateCreditNote(record);
    } else if (record.recordType === 'STOCK_TRANSFER') {
      this.validateStockTransfer(record);
    } else if (record.recordType === 'MALFORMED') {
      // Ensure malformed records have at least one error
      if (record.issues.length === 0) {
        record.issues.push({
          code: IssueCode.MISSING_FIELD,
          severity: IssueSeverity.ERROR,
          message: record.errorSummary || 'Record failed structural syntax validation',
          sourceRowNumber: record.sourceRef.sourceRowNumber,
          sourceReport: record.sourceRef.sourceReport
        });
      }
    }

    // 2. Deduplicate issues on the record by (code, field) to avoid spamming the report
    const uniqueIssues = this.deduplicateIssues(record.issues);
    record.issues = uniqueIssues;

    // 3. Attach document ID and suggested action
    const docId = this.getDocumentId(record);
    for (const issue of uniqueIssues) {
      if (!issue.documentId && docId) {
        issue.documentId = docId;
      }
      if (!issue.suggestedAction) {
        issue.suggestedAction = this.getSuggestedAction(issue.code);
      }
    }

    // 4. Compute status counts
    let errorsCount = 0;
    let warningsCount = 0;
    let reviewCount = 0;

    for (const issue of uniqueIssues) {
      if (issue.severity === IssueSeverity.ERROR) errorsCount++;
      else if (issue.severity === IssueSeverity.WARNING) warningsCount++;
      else if (issue.severity === IssueSeverity.REVIEW) reviewCount++;
    }

    let status = ValidationStatus.VALID;
    if (errorsCount > 0) status = ValidationStatus.ERROR;
    else if (reviewCount > 0) status = ValidationStatus.REVIEW;
    else if (warningsCount > 0) status = ValidationStatus.WARNING;

    return {
      recordId: record.id,
      documentId: docId,
      recordType: record.recordType,
      status,
      errorsCount,
      warningsCount,
      reviewCount,
      issues: uniqueIssues
    };
  }

  private validateOutwardSupply(record: OutwardSupplyRecord): void {
    const issues = record.issues;

    // GST-004 / MISSING_BUYER_GSTIN: B2B without recipient GSTIN
    if (record.recipientType === RecipientType.B2B && (!record.customerGstin || !record.customerGstin.trim())) {
      this.addIssueIfNotPresent(issues, {
        code: IssueCode.B2B_WITHOUT_GSTIN,
        severity: IssueSeverity.ERROR,
        field: 'Customer Bill To GSTIN',
        message: 'B2B outward supply requires a valid recipient GSTIN; cannot be filed without recipient details',
        sourceRowNumber: record.sourceRef.sourceRowNumber,
        sourceReport: record.sourceRef.sourceReport
      });
    }

    // GST-008: Missing HSN/SAC
    if (!record.hsnSac || !record.hsnSac.trim()) {
      this.addIssueIfNotPresent(issues, {
        code: IssueCode.MISSING_HSN,
        severity: IssueSeverity.WARNING,
        field: 'HSN/SAC',
        message: 'HSN/SAC code is missing; required for GSTR-1 outward reporting depending on taxpayer turnover',
        sourceRowNumber: record.sourceRef.sourceRowNumber,
        sourceReport: record.sourceRef.sourceReport
      });
    }

    // GST-015: Configured tax rate catalog validation
    const dateStr = record.invoiceDate ? record.invoiceDate.toISOString().slice(0, 10) : undefined;
    if (!this.catalogue.isRateValid(record.taxBreakdown.taxRate, dateStr)) {
      this.addIssueIfNotPresent(issues, {
        code: IssueCode.INVALID_TAX_RATE,
        severity: IssueSeverity.ERROR,
        field: 'Tax Rate',
        message: `Tax rate ${record.taxBreakdown.taxRate.toString()}% is not found in the active GST rate catalogue`,
        sourceRowNumber: record.sourceRef.sourceRowNumber,
        sourceReport: record.sourceRef.sourceReport
      });
    }

    // GST-001 & GST-002: Intrastate vs Interstate place of supply validation
    const shipFrom = record.shipFromStateCode;
    const pos = record.placeOfSupplyStateCode;

    if (isValidStateCode(shipFrom) && isValidStateCode(pos)) {
      if (shipFrom === pos) {
        // Intrastate supply (GST-001)
        record.supplyType = SupplyType.INTRASTATE;
        if (record.taxBreakdown.igstAmount.gt(0)) {
          this.addIssueIfNotPresent(issues, {
            code: IssueCode.INTRASTATE_WITH_IGST,
            severity: IssueSeverity.ERROR,
            field: 'Tax Components',
            message: `Intrastate supply within state code ${shipFrom} must carry CGST/SGST, not IGST`,
            sourceRowNumber: record.sourceRef.sourceRowNumber,
            sourceReport: record.sourceRef.sourceReport
          });
        }
      } else {
        // Interstate supply (GST-002)
        record.supplyType = SupplyType.INTERSTATE;
        // GST-009: Interstate with CGST/SGST
        if (record.taxBreakdown.cgstAmount.gt(0) || record.taxBreakdown.sgstAmount.gt(0)) {
          this.addIssueIfNotPresent(issues, {
            code: IssueCode.INTERSTATE_WITH_CGST_SGST,
            severity: IssueSeverity.ERROR,
            field: 'Place of Supply',
            message: `Interstate supply from ${shipFrom} to ${pos} carries CGST/SGST instead of IGST (GST-009)`,
            sourceRowNumber: record.sourceRef.sourceRowNumber,
            sourceReport: record.sourceRef.sourceReport
          });
        }
      }
    }
  }

  private validateCreditNote(record: CreditNoteRecord): void {
    // GST-010: Orphan credit note without original invoice reference
    if (!record.originalInvoiceNumber || !record.originalInvoiceNumber.trim()) {
      this.addIssueIfNotPresent(record.issues, {
        code: IssueCode.ORPHAN_CREDIT_NOTE,
        severity: IssueSeverity.WARNING,
        field: 'Original Invoice Number',
        message: 'Credit note has missing original invoice reference (GST-010); reconciliation review required',
        sourceRowNumber: record.sourceRef.sourceRowNumber,
        sourceReport: record.sourceRef.sourceReport
      });
    }
  }

  private validateStockTransfer(record: StockTransferRecord): void {
    // GST-013: Stock transfer between distinct registrations
    if (record.classification === StockTransferClassification.REVIEW_REQUIRED) {
      this.addIssueIfNotPresent(record.issues, {
        code: IssueCode.STOCK_TRANSFER_REVIEW_REQUIRED,
        severity: IssueSeverity.REVIEW,
        field: 'Branch Registration',
        message: 'Stock transfer relationship requires verification against taxpayer branch master (GST-013)',
        sourceRowNumber: record.sourceRef.sourceRowNumber,
        sourceReport: record.sourceRef.sourceReport
      });
    }
  }

  private deduplicateIssues(issues: ValidationIssue[]): ValidationIssue[] {
    const seen = new Set<string>();
    const unique: ValidationIssue[] = [];

    for (const issue of issues) {
      const key = `${issue.code}#${issue.field || 'NO_FIELD'}#${issue.sourceRowNumber}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(issue);
      }
    }
    return unique;
  }

  private addIssueIfNotPresent(issues: ValidationIssue[], issue: ValidationIssue): void {
    const exists = issues.some((i) => i.code === issue.code && i.field === issue.field);
    if (!exists) {
      issues.push(issue);
    }
  }

  private getDocumentId(record: NormalizedRecord): string | undefined {
    if (record.recordType === 'OUTWARD_SUPPLY') return record.invoiceNumber;
    if (record.recordType === 'CREDIT_NOTE') return record.creditNoteNumber;
    if (record.recordType === 'STOCK_TRANSFER') return record.transferInvoiceNumber;
    if (record.recordType === 'CANCELLED_ORDER') return record.orderId;
    return undefined;
  }

  private getSuggestedAction(code: IssueCode | string): string {
    switch (code) {
      case IssueCode.B2B_WITHOUT_GSTIN:
      case IssueCode.MISSING_BUYER_GSTIN:
        return 'Verify customer GSTIN with buyer or reclassify transaction as B2C after customer confirmation.';
      case IssueCode.DUPLICATE_INVOICE_NUMBER:
        return 'Check billing sequence in ERP. Issue credit note or amend duplicate serial number.';
      case IssueCode.INVALID_INVOICE_DATE:
        return 'Correct invoice date format to standard YYYY-MM-DD.';
      case IssueCode.NEGATIVE_TAXABLE_VALUE:
        return 'Issue credit note instead of negative sales invoice line.';
      case IssueCode.TAX_MISMATCH:
        return 'Recalculate tax components using applicable rate and round half-up.';
      case IssueCode.MISSING_HSN:
        return 'Populate appropriate 4/6/8-digit HSN or SAC code.';
      case IssueCode.INVALID_STATE_CODE:
        return 'Correct 2-digit Indian State/UT code to match legal jurisdiction.';
      case IssueCode.MISSING_INVOICE_NUMBER:
        return 'Provide missing invoice serial number.';
      case IssueCode.INTERSTATE_WITH_CGST_SGST:
        return 'Charge IGST on interstate supply or correct Place of Supply state code.';
      case IssueCode.INTRASTATE_WITH_IGST:
        return 'Charge CGST + SGST/UTGST on intrastate supply.';
      case IssueCode.INVALID_TAX_RATE:
        return 'Verify tax rate against statutory GST tariff schedule.';
      case IssueCode.ORPHAN_CREDIT_NOTE:
        return 'Locate original tax invoice and link original invoice number.';
      case IssueCode.CUMULATIVE_REVERSAL_EXCEEDED:
        return 'Reduce credit note amount to match remaining unreconciled invoice balance.';
      case IssueCode.STOCK_TRANSFER_REVIEW_REQUIRED:
        return 'Confirm branch registration status under Section 25(4)/(5) in branch master.';
      default:
        return 'Review transaction attributes and amend prior to GSTR-1 return filing.';
    }
  }
}

export const defaultValidator = new ValidationEngine();
