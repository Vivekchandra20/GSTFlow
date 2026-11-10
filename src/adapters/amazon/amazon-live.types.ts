import { Decimal } from '../../utils/decimal.js';
import {
  MappingEvidence,
  AmazonReportFormat,
  AmazonHeaderVersion
} from './evidence-classification.js';

export {
  MappingEvidence,
  AmazonReportFormat,
  AmazonHeaderVersion
};

export type CanonicalAmazonField =
  // Mandatory Core
  | 'sellerGstin'
  | 'invoiceNumber'
  | 'invoiceDate'
  | 'transactionType'
  | 'orderId'
  
  // Logistics & Line IDs
  | 'shipmentId'
  | 'shipmentItemId'
  | 'creditNoteNumber'
  | 'creditNoteDate'
  
  // Catalog
  | 'asin'
  | 'sku'
  | 'itemDescription'
  | 'hsnSac'
  | 'productTaxCode'
  | 'quantity'
  
  // Addresses & Jurisdictions
  | 'billFromCity'
  | 'billFromState'
  | 'shipFromState'
  | 'shipFromCity'
  | 'shipToState'
  | 'shipToCity'
  | 'customerBillToGstin'
  | 'customerShipToGstin'
  | 'placeOfSupply'
  
  // Valuation Bases
  | 'principalAmountBasis'
  | 'shippingAmountBasis'
  | 'giftWrapAmountBasis'
  | 'itemPromoDiscountBasis'
  | 'shippingPromoDiscountBasis'
  | 'giftWrapPromoDiscountBasis'
  | 'taxExclusiveGross'
  
  // Taxes
  | 'cgstRate'
  | 'cgstAmount'
  | 'sgstRate'
  | 'sgstAmount'
  | 'utgstRate'
  | 'utgstAmount'
  | 'igstRate'
  | 'igstAmount'
  | 'cessAmount'
  | 'totalTaxAmount'
  | 'invoiceAmount'
  
  // Section 52 TCS
  | 'tcsCgstAmount'
  | 'tcsSgstAmount'
  | 'tcsIgstAmount'
  
  // Warehouse & E-Invoicing
  | 'fulfillmentChannel'
  | 'warehouseId'
  | 'irnNumber'
  | 'irnStatus'
  | 'irnDate';

export interface ThreeTierAmount {
  /** Original unparsed text from CSV export (e.g. "-1000.00") */
  rawText: string;
  /** Parsed signed Decimal.js value with sign preserved (e.g. Decimal(-1000.00)) */
  signedAmount: Decimal;
  /** Unsigned positive magnitude for canonical domain schemas (e.g. Decimal(1000.00)) */
  normalizedMagnitude: Decimal;
}

export interface LiveSourceProvenance {
  /** Source report filename or label */
  sourceReport: string;
  /** SHA-256 hash of the ingested CSV file */
  fileFingerprint: string;
  /** Ingestion batch UUID */
  importBatchId: string;
  /** Identified tax period (e.g. '2026-10' or 'ON_DEMAND') */
  reportPeriod?: string;
  /** Exact physical CSV line coordinate (info.lines) */
  physicalLineNumber: number;
  /** 1-based incremental yielded record index */
  logicalRecordNumber: number;
}

export interface AmazonMtrMetadata {
  /** Provenance tracking coordinates */
  provenance: LiveSourceProvenance;

  /** Identified report format */
  reportFormat?: AmazonReportFormat;
  /** Identified header schema version */
  headerVersion?: AmazonHeaderVersion;
  /** Unmapped or extra columns detected on the row */
  unknownColumns?: string[];

  /** Three-tier representation of product principal base */
  principalAmountBasis?: ThreeTierAmount;
  /** Three-tier representation of shipping base */
  shippingAmountBasis?: ThreeTierAmount;
  /** Three-tier representation of gift-wrapping base */
  giftWrapAmountBasis?: ThreeTierAmount;
  /** Three-tier representation of promotional discounts */
  itemPromoDiscountBasis?: ThreeTierAmount;
  shippingPromoDiscountBasis?: ThreeTierAmount;
  giftWrapPromoDiscountBasis?: ThreeTierAmount;

  /** Amazon-reported gross totals */
  taxExclusiveGross?: ThreeTierAmount;
  totalTaxAmount?: ThreeTierAmount;
  invoiceAmount?: ThreeTierAmount;

  /** Amazon-reported component taxes */
  reportedCgst?: ThreeTierAmount;
  reportedSgst?: ThreeTierAmount;
  reportedUtgst?: ThreeTierAmount;
  reportedIgst?: ThreeTierAmount;
  reportedCess?: ThreeTierAmount;

  /** Section 52 TCS Withholding (actual platform deductions) */
  reportedTcsCgst?: ThreeTierAmount;
  reportedTcsSgst?: ThreeTierAmount;
  reportedTcsIgst?: ThreeTierAmount;

  /** Fulfillment & catalog properties */
  fulfillmentChannel?: 'AFN' | 'MFN' | string;
  warehouseId?: string;
  asin?: string;
  productTaxCode?: string;

  /** E-Invoicing and statutory references */
  irnNumber?: string;
  irnStatus?: string;
  irnDate?: string;

  /** Transaction evidence flags */
  evidenceFlags: {
    explicitRefundTag: boolean;
    hasCreditNoteNumber: boolean;
    isSignedNegative: boolean;
    hasOriginalInvoiceRef: boolean;
    isPreDispatchCancel: boolean;
  };
}

export interface AmazonMtrLiveAdapterOptions {
  /** Report name or path label */
  sourceReportName: string;
  /** Optional unique import batch ID (generated automatically if omitted) */
  importBatchId?: string;
  /** Expected Seller GSTIN (e.g. from authenticated organization registration) to detect mismatches */
  expectedSellerGstin?: string;
  /** Enable Tier 3 unverified / speculative aliases (disabled by default) */
  enableTier3Unverified?: boolean;
  /** Optional custom header mapping overrides */
  headerOverrides?: Partial<Record<CanonicalAmazonField, string[]>>;
  /** Calculation tolerance policy */
  reconciliationTolerance?: Decimal;
}

export class UnsupportedReportFormatError extends Error {
  public missingHeaders: CanonicalAmazonField[];
  public detectedHeaders: string[];

  constructor(message: string, missingHeaders: CanonicalAmazonField[], detectedHeaders: string[]) {
    super(message);
    this.name = 'UnsupportedReportFormatError';
    this.missingHeaders = missingHeaders;
    this.detectedHeaders = detectedHeaders;
  }
}

export class DuplicateCanonicalHeaderError extends Error {
  public canonicalField: CanonicalAmazonField;
  public conflictingHeaders: string[];

  constructor(canonicalField: CanonicalAmazonField, conflictingHeaders: string[]) {
    super(
      `Multiple CSV columns resolve to identical canonical field '${canonicalField}': [${conflictingHeaders.join(', ')}]`
    );
    this.name = 'DuplicateCanonicalHeaderError';
    this.canonicalField = canonicalField;
    this.conflictingHeaders = conflictingHeaders;
  }
}
