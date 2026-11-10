import {
  NormalizedRecord,
  OutwardSupplyRecord,
  ValidationIssue
} from '../models/transaction.schema.js';
import { IssueCode, IssueSeverity } from '../models/enums.js';

export interface DocumentHeaderMetadata {
  sellerGstin: string;
  financialYear: string;
  invoiceNumber: string;
  invoiceDate: string; // ISO date string (YYYY-MM-DD)
  customerGstin?: string;
  placeOfSupplyStateCode?: string;
  sourceReport: string;
  firstSeenSourceRowNumber: number;
  totalLinesRegistered: number;
}

export interface DeduplicationOptions {
  scopeByFinancialYear?: boolean; // Defaults to true
  scopeBySeller?: boolean;        // Defaults to true (statutory GST scope), false for marketplace-wide invoice uniqueness
}

export class DeduplicationEngine {
  // Document index: keyed by `${sellerGstin}#${financialYear}#${invoiceNumber}`
  private documentHeaders = new Map<string, DocumentHeaderMetadata>();

  // Source row index: keyed by `${sourceReport}#${sourceRowNumber}` to detect re-ingestion
  private ingestedSourceRows = new Set<string>();

  // Line item signatures within an invoice: keyed by `${docKey}#${sku}#${shipmentId}#${taxable}#${qty}`
  private lineItemOccurrences = new Map<string, number>();

  /**
   * Resets internal deduplication registries.
   */
  public reset(): void {
    this.documentHeaders.clear();
    this.ingestedSourceRows.clear();
    this.lineItemOccurrences.clear();
  }

  /**
   * Evaluates document-level and line-item duplicates on a normalized record.
   * Attaches structured issues if duplicates or conflicts are detected, without silently dropping records.
   */
  public processRecord(record: NormalizedRecord, options: DeduplicationOptions = { scopeByFinancialYear: true, scopeBySeller: true }): NormalizedRecord {
    // Deduplication applies specifically to outward supplies
    if (record.recordType !== 'OUTWARD_SUPPLY') {
      return record;
    }

    const outward = record as OutwardSupplyRecord;
    const sellerGstin = options.scopeBySeller !== false ? (outward.sellerGstin || 'UNKNOWN_SELLER') : 'MARKETPLACE_GLOBAL';
    const invoiceNumber = outward.invoiceNumber || 'UNKNOWN_INVOICE';
    const financialYear = options.scopeByFinancialYear !== false ? (outward.financialYear || 'UNKNOWN_FY') : 'GLOBAL_FY';
    const docKey = `${sellerGstin}#${financialYear}#${invoiceNumber}`;

    // 1. Check repeated ingestion of exact source row
    const sourceRowKey = `${outward.sourceRef.sourceReport}#${outward.sourceRef.sourceRowNumber}`;
    if (this.ingestedSourceRows.has(sourceRowKey)) {
      const issue: ValidationIssue = {
        code: IssueCode.DUPLICATE_LINE_ITEM,
        severity: IssueSeverity.ERROR,
        field: 'Source Row Number',
        message: `Repeated ingestion of identical source record (Report: ${outward.sourceRef.sourceReport}, Row: ${outward.sourceRef.sourceRowNumber})`,
        sourceRowNumber: outward.sourceRef.sourceRowNumber,
        sourceReport: outward.sourceRef.sourceReport
      };
      outward.issues.push(issue);
      return outward;
    }
    this.ingestedSourceRows.add(sourceRowKey);

    const invoiceDateStr = outward.invoiceDate.toISOString().slice(0, 10);
    const existingHeader = this.documentHeaders.get(docKey);

    if (!existingHeader) {
      // First line of this invoice document
      this.documentHeaders.set(docKey, {
        sellerGstin,
        financialYear,
        invoiceNumber,
        invoiceDate: invoiceDateStr,
        customerGstin: outward.customerGstin,
        placeOfSupplyStateCode: outward.placeOfSupplyStateCode,
        sourceReport: outward.sourceRef.sourceReport,
        firstSeenSourceRowNumber: outward.sourceRef.sourceRowNumber,
        totalLinesRegistered: 1
      });
    } else {
      // Subsequent line of this invoice document
      existingHeader.totalLinesRegistered++;

      // Document-Level Conflict Check:
      // Verify that this subsequent row shares the same header attributes
      const dateConflict = existingHeader.invoiceDate !== invoiceDateStr;
      const buyerConflict =
        (existingHeader.customerGstin || '') !== (outward.customerGstin || '');
      const posConflict =
        (existingHeader.placeOfSupplyStateCode || '') !== (outward.placeOfSupplyStateCode || '');

      if (dateConflict || buyerConflict || posConflict) {
        // Inconsistent header details indicate a duplicate invoice number issued to different entities/dates (GST-005)
        const conflictReasons: string[] = [];
        if (dateConflict) {
          conflictReasons.push(`date conflict (original: ${existingHeader.invoiceDate}, current: ${invoiceDateStr})`);
        }
        if (buyerConflict) {
          conflictReasons.push(
            `buyer conflict (original: '${existingHeader.customerGstin || 'BLANK'}', current: '${outward.customerGstin || 'BLANK'}')`
          );
        }
        if (posConflict) {
          conflictReasons.push(
            `place of supply conflict (original: '${existingHeader.placeOfSupplyStateCode}', current: '${outward.placeOfSupplyStateCode}')`
          );
        }

        const issue: ValidationIssue = {
          code: IssueCode.DUPLICATE_INVOICE_NUMBER,
          severity: IssueSeverity.ERROR,
          field: 'Invoice Number',
          message: `Duplicate invoice number '${invoiceNumber}' detected for seller ${sellerGstin} in FY ${financialYear} with header conflicts: ${conflictReasons.join('; ')} (First seen in row ${existingHeader.firstSeenSourceRowNumber})`,
          sourceRowNumber: outward.sourceRef.sourceRowNumber,
          sourceReport: outward.sourceRef.sourceReport
        };
        outward.issues.push(issue);
        return outward;
      }
    }

    // Line-Item Level Evaluation (GST-011):
    // Preserves legitimate multi-SKU lines belonging to the same order/invoice.
    // Also tracks identical item lines to detect suspected exact-duplicate lines within the invoice.
    const sku = outward.sku || 'NO_SKU';
    const shipmentId = outward.shipmentId || 'NO_SHP';
    const taxableStr = outward.taxBreakdown.taxableValue.toFixed(2);
    const qty = outward.quantity || 1;
    const lineSignature = `${docKey}#${sku}#${shipmentId}#${taxableStr}#${qty}`;

    const occurrence = (this.lineItemOccurrences.get(lineSignature) || 0) + 1;
    this.lineItemOccurrences.set(lineSignature, occurrence);

    return outward;
  }

  public getDocumentCount(): number {
    return this.documentHeaders.size;
  }

  public getDocumentHeader(sellerGstin: string, financialYear: string, invoiceNumber: string): DocumentHeaderMetadata | undefined {
    return this.documentHeaders.get(`${sellerGstin}#${financialYear}#${invoiceNumber}`);
  }
}

export const defaultDeduplicator = new DeduplicationEngine();
