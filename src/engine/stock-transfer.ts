import { StockTransferRecord, ValidationIssue } from '../models/transaction.schema.js';
import { StockTransferClassification, IssueCode, IssueSeverity, SupplyType } from '../models/enums.js';
import { extractPANFromGSTIN, isValidGSTINStructure } from '../utils/state-codes.js';

export interface IRegistrationRelationshipResolver {
  /**
   * Returns true if destination GSTIN is a verified branch / distinct registration of the same legal entity.
   */
  isVerifiedDistinctPerson(sourceGstin: string, destinationGstin: string): boolean;

  /**
   * Returns true if source and destination entities are known related persons under Section 15 explanation.
   */
  isRelatedEntity(sourcePan: string, destinationPan: string): boolean;
}

export class DefaultRegistrationRelationshipResolver implements IRegistrationRelationshipResolver {
  private verifiedBranchPairs = new Set<string>();
  private knownRelatedPanPairs = new Set<string>();

  public registerVerifiedBranch(sourceGstin: string, destinationGstin: string): void {
    const pair = `${sourceGstin.trim().toUpperCase()}#${destinationGstin.trim().toUpperCase()}`;
    this.verifiedBranchPairs.add(pair);
  }

  public registerRelatedEntity(panA: string, panB: string): void {
    this.knownRelatedPanPairs.add(`${panA.trim().toUpperCase()}#${panB.trim().toUpperCase()}`);
    this.knownRelatedPanPairs.add(`${panB.trim().toUpperCase()}#${panA.trim().toUpperCase()}`);
  }

  public isVerifiedDistinctPerson(sourceGstin: string, destinationGstin: string): boolean {
    const pair = `${sourceGstin.trim().toUpperCase()}#${destinationGstin.trim().toUpperCase()}`;
    return this.verifiedBranchPairs.has(pair);
  }

  public isRelatedEntity(sourcePan: string, destinationPan: string): boolean {
    return this.knownRelatedPanPairs.has(`${sourcePan.trim().toUpperCase()}#${destinationPan.trim().toUpperCase()}`);
  }
}

export class StockTransferProcessor {
  private resolver: IRegistrationRelationshipResolver;

  constructor(resolver: IRegistrationRelationshipResolver = new DefaultRegistrationRelationshipResolver()) {
    this.resolver = resolver;
  }

  /**
   * Classifies a StockTransferRecord according to GST statutory provisions:
   * - Section 25(4) / Section 25(5) of CGST Act: Distinct persons (deemed supplies under Schedule I).
   * - Section 15 explanation: Related person transactions.
   * - Inter-company supply vs. Review Required.
   * Note: PAN equality ALONE does NOT prove distinct-person status; verification against branch master data is required.
   */
  public classifyTransfer(transfer: StockTransferRecord): StockTransferRecord {
    const srcGstin = transfer.sourceGstin ? transfer.sourceGstin.trim().toUpperCase() : '';
    const destGstin = transfer.destinationGstin ? transfer.destinationGstin.trim().toUpperCase() : '';

    const srcPan = extractPANFromGSTIN(srcGstin) || '';
    const destPan = extractPANFromGSTIN(destGstin) || '';

    // Update PAN fields on the record
    transfer.sourcePan = srcPan;
    transfer.destinationPan = destPan;

    // GSTIN format checks
    if (!isValidGSTINStructure(srcGstin) || !isValidGSTINStructure(destGstin)) {
      transfer.classification = StockTransferClassification.UNKNOWN;
      transfer.issues.push({
        code: IssueCode.STOCK_TRANSFER_REVIEW_REQUIRED,
        severity: IssueSeverity.ERROR,
        field: 'Source / Destination GSTIN',
        message: 'Stock transfer contains unparseable or structurally invalid GSTIN(s)',
        sourceRowNumber: transfer.sourceRef.sourceRowNumber,
        sourceReport: transfer.sourceRef.sourceReport
      });
      return transfer;
    }

    // 1. Same PAN evaluation
    if (srcPan && destPan && srcPan === destPan) {
      if (srcGstin === destGstin) {
        // Same GSTIN transfer (intra-unit / same registration)
        transfer.classification = StockTransferClassification.REVIEW_REQUIRED;
        transfer.issues.push({
          code: IssueCode.STOCK_TRANSFER_REVIEW_REQUIRED,
          severity: IssueSeverity.WARNING,
          field: 'Destination GSTIN',
          message: 'Stock transfer source and destination GSTIN are identical; check if intra-unit non-taxable movement',
          sourceRowNumber: transfer.sourceRef.sourceRowNumber,
          sourceReport: transfer.sourceRef.sourceReport
        });
        return transfer;
      }

      // Check if verified in master data
      if (this.resolver.isVerifiedDistinctPerson(srcGstin, destGstin)) {
        // Confirmed Distinct Person under Section 25(4)/(5) (GST-013)
        transfer.classification = StockTransferClassification.DISTINCT_PERSON_SUPPLY;
        return transfer;
      } else {
        // PAN matches across different state GSTINs, but branch registration is unverified in master data
        transfer.classification = StockTransferClassification.REVIEW_REQUIRED;
        transfer.issues.push({
          code: IssueCode.STOCK_TRANSFER_REVIEW_REQUIRED,
          severity: IssueSeverity.REVIEW,
          field: 'Distinct Person Verification',
          message: `PAN (${srcPan}) matches across registrations, but branch relationship requires verification (GST-013)`,
          sourceRowNumber: transfer.sourceRef.sourceRowNumber,
          sourceReport: transfer.sourceRef.sourceReport
        });
        return transfer;
      }
    }

    // 2. Different PAN evaluation
    if (srcPan && destPan && srcPan !== destPan) {
      if (this.resolver.isRelatedEntity(srcPan, destPan)) {
        // Related Person under Section 15 explanation
        transfer.classification = StockTransferClassification.RELATED_PERSON_SUPPLY;
        return transfer;
      } else {
        // Different PAN entities without established relationship -> Commercial Inter-Company transfer
        transfer.classification = StockTransferClassification.INTER_COMPANY_SUPPLY;
        return transfer;
      }
    }

    transfer.classification = StockTransferClassification.UNKNOWN;
    return transfer;
  }
}

export const defaultStockTransferProcessor = new StockTransferProcessor();
