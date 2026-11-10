import {
  NormalizedRecord,
  OutwardSupplyRecord,
  ValidationIssue
} from '../models/transaction.schema.js';
import {
  RecipientType,
  IssueCode,
  IssueSeverity
} from '../models/enums.js';
import { isValidGSTINStructure, isValidStateCode } from '../utils/state-codes.js';

export enum RouteDestination {
  B2B_SUPPLY = 'B2B_SUPPLY',
  B2C_SUPPLY = 'B2C_SUPPLY',
  CREDIT_NOTE = 'CREDIT_NOTE',
  STOCK_TRANSFER = 'STOCK_TRANSFER',
  CANCELLED_ORDER = 'CANCELLED_ORDER',
  EXCEPTION_REVIEW = 'EXCEPTION_REVIEW',
  MALFORMED_REVIEW = 'MALFORMED_REVIEW'
}

export enum GSTINEvidenceStatus {
  MISSING = 'MISSING',
  INVALID_FORMAT = 'INVALID_FORMAT',
  UNVERIFIED_SYNTHETIC = 'UNVERIFIED_SYNTHETIC', // Valid structure (state code + PAN shape), checksum unasserted
  VERIFIED_CHECKSUM = 'VERIFIED_CHECKSUM'
}

/**
 * Evaluates GSTIN evidence status without rejecting format-shaped synthetic test fixtures.
 */
export function evaluateGSTINEvidence(gstin: string | null | undefined): GSTINEvidenceStatus {
  if (!gstin || !gstin.trim()) {
    return GSTINEvidenceStatus.MISSING;
  }
  const trimmed = gstin.trim().toUpperCase();

  if (trimmed.length !== 15) {
    return GSTINEvidenceStatus.INVALID_FORMAT;
  }

  const stateCode = trimmed.slice(0, 2);
  if (!isValidStateCode(stateCode)) {
    return GSTINEvidenceStatus.INVALID_FORMAT;
  }

  if (!isValidGSTINStructure(trimmed)) {
    return GSTINEvidenceStatus.INVALID_FORMAT;
  }

  // Format is valid (state code + PAN shape + entity + Z + check digit)
  // Synthetic data identifiers do not assert registration/checksum validity
  return GSTINEvidenceStatus.UNVERIFIED_SYNTHETIC;
}

export interface RoutedTransaction {
  record: NormalizedRecord;
  destination: RouteDestination;
  routingReasons: string[];
}

export class RouterEngine {
  /**
   * Deterministically routes a normalized record to its appropriate workflow.
   * Enforces that B2B without recipient GSTIN is flagged with B2B_WITHOUT_GSTIN and never demoted to B2C.
   */
  public route(record: NormalizedRecord): RoutedTransaction {
    const reasons: string[] = [];

    // 1. Malformed records
    if (record.recordType === 'MALFORMED') {
      reasons.push('Record has malformed syntax or unparseable mandatory headers');
      return {
        record,
        destination: RouteDestination.MALFORMED_REVIEW,
        routingReasons: reasons
      };
    }

    // 2. Cancelled orders
    if (record.recordType === 'CANCELLED_ORDER') {
      reasons.push('Order cancelled before invoice issuance; non-taxable supply (GST-012)');
      return {
        record,
        destination: RouteDestination.CANCELLED_ORDER,
        routingReasons: reasons
      };
    }

    // 3. Stock transfers
    if (record.recordType === 'STOCK_TRANSFER') {
      reasons.push('Inter-branch inventory movement routed to stock transfer workflow (GST-013)');
      return {
        record,
        destination: RouteDestination.STOCK_TRANSFER,
        routingReasons: reasons
      };
    }

    // 4. Credit notes
    if (record.recordType === 'CREDIT_NOTE') {
      reasons.push('Adjustment/reversal transaction routed to credit note reconciliation path');
      return {
        record,
        destination: RouteDestination.CREDIT_NOTE,
        routingReasons: reasons
      };
    }

    // 5. Outward Supplies (Shipments)
    return this.routeOutwardSupply(record, reasons);
  }

  private routeOutwardSupply(record: OutwardSupplyRecord, reasons: string[]): RoutedTransaction {
    const customerGstin = record.customerGstin ? record.customerGstin.trim() : '';
    const gstinStatus = evaluateGSTINEvidence(customerGstin);

    // Rule: B2B transaction evaluation
    if (record.recipientType === RecipientType.B2B) {
      if (gstinStatus === GSTINEvidenceStatus.MISSING) {
        // GST-004: B2B without recipient GSTIN must NOT be silently classified as B2C or valid B2B
        const issue: ValidationIssue = {
          code: IssueCode.B2B_WITHOUT_GSTIN,
          severity: IssueSeverity.ERROR,
          field: 'Customer Bill To GSTIN',
          message: 'B2B outward supply transaction is missing recipient GSTIN (GST-004)',
          sourceRowNumber: record.sourceRef.sourceRowNumber,
          sourceReport: record.sourceRef.sourceReport
        };
        record.issues.push(issue);
        reasons.push('Declared as B2B but lacks recipient GSTIN; flagged for review');
        return {
          record,
          destination: RouteDestination.EXCEPTION_REVIEW,
          routingReasons: reasons
        };
      }

      if (gstinStatus === GSTINEvidenceStatus.INVALID_FORMAT) {
        const issue: ValidationIssue = {
          code: IssueCode.MISSING_BUYER_GSTIN,
          severity: IssueSeverity.ERROR,
          field: 'Customer Bill To GSTIN',
          message: `B2B outward supply has invalid recipient GSTIN format: '${customerGstin}'`,
          sourceRowNumber: record.sourceRef.sourceRowNumber,
          sourceReport: record.sourceRef.sourceReport
        };
        record.issues.push(issue);
        reasons.push(`Invalid recipient GSTIN format (${customerGstin}); routed to review`);
        return {
          record,
          destination: RouteDestination.EXCEPTION_REVIEW,
          routingReasons: reasons
        };
      }

      // Valid or unverified synthetic GSTIN evidence present
      reasons.push('Valid B2B outward supply with recipient GSTIN evidence');
      return {
        record,
        destination: RouteDestination.B2B_SUPPLY,
        routingReasons: reasons
      };
    }

    // Rule: B2C transaction evaluation
    if (record.recipientType === RecipientType.B2C) {
      if (customerGstin) {
        // B2C declared but contains a populated recipient GSTIN -> Ambiguous transaction
        const issue: ValidationIssue = {
          code: IssueCode.B2B_WITHOUT_GSTIN,
          severity: IssueSeverity.REVIEW,
          field: 'Customer Bill To GSTIN',
          message: 'Transaction declared as B2C contains a populated customer GSTIN; review for B2B reclassification',
          sourceRowNumber: record.sourceRef.sourceRowNumber,
          sourceReport: record.sourceRef.sourceReport
        };
        record.issues.push(issue);
        reasons.push('Declared as B2C but carries customer GSTIN; routed to exception review');
        return {
          record,
          destination: RouteDestination.EXCEPTION_REVIEW,
          routingReasons: reasons
        };
      }

      // GST-003: Clean B2C invoice without recipient GSTIN; do not invent GSTIN
      reasons.push('Valid B2C outward supply to unregistered consumer (GST-003)');
      return {
        record,
        destination: RouteDestination.B2C_SUPPLY,
        routingReasons: reasons
      };
    }

    // RecipientType.UNKNOWN or other ambiguity
    reasons.push('Unrecognized recipient type classification; routed to exception review');
    return {
      record,
      destination: RouteDestination.EXCEPTION_REVIEW,
      routingReasons: reasons
    };
  }
}

export const defaultRouter = new RouterEngine();
