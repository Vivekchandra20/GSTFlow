/**
 * Phase 5A: Amazon MTR Adapter & Statutory Evidence Classification
 *
 * Authoritative mapping evidence levels and field classification catalog.
 * In Phase 5A, REAL_WORLD_VERIFIED remains strictly unavailable as genuine seller exports
 * are deferred to Phase 5B.
 */

export enum MappingEvidence {
  /** Supported directly by official Amazon Seller Central documentation / GST Help reference */
  DOCUMENTATION_VERIFIED = 'DOCUMENTATION_VERIFIED',

  /** Supported by existing GSTFlow domain engine contracts and statutory tax rules */
  EXISTING_ENGINE_VERIFIED = 'EXISTING_ENGINE_VERIFIED',

  /** Tested and verified using comprehensive synthetic test fixtures */
  SYNTHETIC_TESTED = 'SYNTHETIC_TESTED',

  /**
   * Tested against genuine seller exports.
   * STRICT INVARIANT: Must remain unavailable in Phase 5A until genuine exports are ingested in Phase 5B.
   */
  REAL_WORLD_VERIFIED = 'REAL_WORLD_VERIFIED',

  /** Insufficient documentary or empirical evidence */
  UNVERIFIED = 'UNVERIFIED'
}

export enum AmazonReportFormat {
  /** Business-to-business outward supply report with Buyer GSTIN */
  MTR_B2B = 'MTR_B2B',

  /** Retail outward supply report for unregistered consumers */
  MTR_B2C = 'MTR_B2C',

  /** Unified forward sales & credit notes with mixed recipient types */
  MTR_UNIFIED = 'MTR_UNIFIED',

  /** Stock Transfer Report capturing non-marketplace warehouse movements */
  STOCK_TRANSFER = 'STOCK_TRANSFER',

  /** Unrecognized or unsupported file structure */
  UNKNOWN = 'UNKNOWN'
}

export enum AmazonHeaderVersion {
  /** Current documented standard: Post-19 Feb 2021 with Customer Bill to GSTIN */
  V2021_POST_FEB = 'V2021_POST_FEB',

  /** Historical documented standard: Pre-19 Feb 2021 with Customer Ship to GSTIN */
  V2021_PRE_FEB = 'V2021_PRE_FEB',

  /** Stock Transfer Report 32-column schema */
  STR_V1 = 'STR_V1',

  /** Unknown header schema */
  UNKNOWN_VERSION = 'UNKNOWN_VERSION'
}

export interface FieldEvidenceEntry {
  canonicalField: string;
  primaryHeader: string;
  aliases: string[];
  classification: MappingEvidence;
  docSource: string;
  statutoryPurpose: string;
  description: string;
}

export const AMAZON_FIELD_EVIDENCE_CATALOG: Record<string, FieldEvidenceEntry> = {
  sellerGstin: {
    canonicalField: 'sellerGstin',
    primaryHeader: 'Seller GSTIN',
    aliases: ['Seller GSTIN', 'Seller GSTIN Number', 'Gstin Of Supplier'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central GST Help Reference (202171900)',
    statutoryPurpose: 'Section 31 Tax Invoice supplier identification',
    description: '15-character alphanumeric GSTIN of the dispatch origin entity.'
  },
  invoiceNumber: {
    canonicalField: 'invoiceNumber',
    primaryHeader: 'Invoice Number',
    aliases: ['Invoice Number', 'Tax Invoice No'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central GST Help Reference',
    statutoryPurpose: 'Rule 46(b) CGST Rules sequential invoice identifier',
    description: 'Tax invoice sequential series identifier.'
  },
  invoiceDate: {
    canonicalField: 'invoiceDate',
    primaryHeader: 'Invoice Date',
    aliases: ['Invoice Date', 'Tax Invoice Date'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central GST Help Reference',
    statutoryPurpose: 'Rule 46(c) CGST Rules tax point date',
    description: 'Timestamp or calendar date when tax invoice was issued.'
  },
  transactionType: {
    canonicalField: 'transactionType',
    primaryHeader: 'Transaction Type',
    aliases: ['Transaction Type'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central Tax Document Library',
    statutoryPurpose: 'Commercial transaction classification (Shipment vs Refund vs FC_TRANSFER)',
    description: 'Indicates forward shipment, credit note refund, cancellation, or stock transfer.'
  },
  orderId: {
    canonicalField: 'orderId',
    primaryHeader: 'Order ID',
    aliases: ['Order ID', 'Order Id'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central Tax Document Library',
    statutoryPurpose: 'Commercial order tracking & Section 52 ECO transaction record',
    description: 'Amazon 3-7-7 marketplace order identifier.'
  },
  shipmentId: {
    canonicalField: 'shipmentId',
    primaryHeader: 'Shipment ID',
    aliases: ['Shipment ID', 'Shipment Id'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central Tax Document Library',
    statutoryPurpose: 'Logistics fulfillment token',
    description: 'Package fulfillment tracking token.'
  },
  shipmentItemId: {
    canonicalField: 'shipmentItemId',
    primaryHeader: 'Shipment Item ID',
    aliases: ['Shipment Item ID', 'Shipment Item Id'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central Tax Document Library',
    statutoryPurpose: 'Multi-item order line disambiguation',
    description: 'Line item package identifier within a shipment.'
  },
  creditNoteNumber: {
    canonicalField: 'creditNoteNumber',
    primaryHeader: 'Credit Note No',
    aliases: ['Credit Note No', 'Credit Note Number'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central GST Help Reference',
    statutoryPurpose: 'Section 34 CGST Act credit note identifier',
    description: 'Statutory credit note sequential number.'
  },
  creditNoteDate: {
    canonicalField: 'creditNoteDate',
    primaryHeader: 'Credit Note Date',
    aliases: ['Credit Note Date'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central GST Help Reference',
    statutoryPurpose: 'Section 34 CGST Act credit note tax point date',
    description: 'Date of issuance of credit note.'
  },
  asin: {
    canonicalField: 'asin',
    primaryHeader: 'ASIN',
    aliases: ['ASIN', 'Asin'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central Product Catalog Reference',
    statutoryPurpose: 'Marketplace catalog identification',
    description: 'Amazon Standard Identification Number (10 characters).'
  },
  sku: {
    canonicalField: 'sku',
    primaryHeader: 'SKU',
    aliases: ['SKU', 'Sku'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central Product Catalog Reference',
    statutoryPurpose: 'Seller inventory reconciliation',
    description: 'Seller Stock Keeping Unit code.'
  },
  itemDescription: {
    canonicalField: 'itemDescription',
    primaryHeader: 'Item Description',
    aliases: ['Item Description'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central GST Help Reference',
    statutoryPurpose: 'Rule 46(f) description of goods',
    description: 'Commercial title or description of supplied goods.'
  },
  hsnSac: {
    canonicalField: 'hsnSac',
    primaryHeader: 'HSN/SAC',
    aliases: ['HSN/SAC', 'Hsn Code'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central GST Help Reference',
    statutoryPurpose: 'Rule 46(g) Harmonized System of Nomenclature code',
    description: '2 to 8 digit statutory HSN or SAC code.'
  },
  productTaxCode: {
    canonicalField: 'productTaxCode',
    primaryHeader: 'Product Tax Code',
    aliases: ['Product Tax Code'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central Tax Document Library',
    statutoryPurpose: 'Internal marketplace tax rate mapping',
    description: 'Amazon internal product tax classification code (e.g. A_GEN_STANDARD).'
  },
  quantity: {
    canonicalField: 'quantity',
    primaryHeader: 'Quantity',
    aliases: ['Quantity'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central GST Help Reference',
    statutoryPurpose: 'Rule 46(h) quantity of goods supplied',
    description: 'Physical units supplied (positive on shipment; negative or positive on return).'
  },
  billFromCity: {
    canonicalField: 'billFromCity',
    primaryHeader: 'Bill From City',
    aliases: ['Bill From City', 'Ship From City'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central GST Help Reference',
    statutoryPurpose: 'Supplier address origin',
    description: 'Origin city of dispatch.'
  },
  billFromState: {
    canonicalField: 'billFromState',
    primaryHeader: 'Bill From State',
    aliases: ['Bill From State'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central GST Help Reference',
    statutoryPurpose: 'Supplier registered location',
    description: 'State name of registered supplier premises.'
  },
  shipFromState: {
    canonicalField: 'shipFromState',
    primaryHeader: 'Ship From State',
    aliases: ['Ship From State'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central GST Help Reference',
    statutoryPurpose: 'Section 10 IGST Act location of supplier / dispatch origin',
    description: 'Origin state from which physical goods were dispatched.'
  },
  shipFromCity: {
    canonicalField: 'shipFromCity',
    primaryHeader: 'Ship From City',
    aliases: ['Ship From City'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central GST Help Reference',
    statutoryPurpose: 'Physical fulfillment origin location',
    description: 'City from which physical goods were dispatched.'
  },
  shipToState: {
    canonicalField: 'shipToState',
    primaryHeader: 'Ship To State',
    aliases: ['Ship To State'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central GST Help Reference',
    statutoryPurpose: 'Section 10(1)(a) & 10(1)(ca) delivery destination',
    description: 'Destination state where goods are delivered.'
  },
  shipToCity: {
    canonicalField: 'shipToCity',
    primaryHeader: 'Ship To City',
    aliases: ['Ship To City'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central GST Help Reference',
    statutoryPurpose: 'Physical fulfillment destination location',
    description: 'City where goods are delivered.'
  },
  customerBillToGstin: {
    canonicalField: 'customerBillToGstin',
    primaryHeader: 'Customer Bill to GSTIN',
    aliases: ['Customer Bill to GSTIN', 'Customer Bill-to GSTIN', 'Customer Bill To GSTIN'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central GST Help Reference (Post-19 Feb 2021 Update)',
    statutoryPurpose: 'Section 10(1)(b) Place of Supply on tripartite B2B orders',
    description: 'Registered GSTIN of the purchasing business buyer.'
  },
  customerShipToGstin: {
    canonicalField: 'customerShipToGstin',
    primaryHeader: 'Customer Ship to GSTIN',
    aliases: ['Customer Ship to GSTIN', 'Customer Ship-to GSTIN', 'Customer Ship To GSTIN', 'Gstin Of Receiver'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central Historical Schema (Pre-19 Feb 2021)',
    statutoryPurpose: 'Historical tripartite delivery GSTIN & STR recipient GSTIN',
    description: 'Destination GSTIN for pre-2021 B2B or stock transfer movements.'
  },
  placeOfSupply: {
    canonicalField: 'placeOfSupply',
    primaryHeader: 'Place of Supply',
    aliases: ['Place of Supply', 'Place Of Supply'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central Tax Document Library',
    statutoryPurpose: 'Statutory Place of Supply state determination',
    description: 'Reported place of supply jurisdiction.'
  },
  principalAmountBasis: {
    canonicalField: 'principalAmountBasis',
    primaryHeader: 'Principal Amount Basis',
    aliases: ['Principal Amount Basis'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central GST Help Reference',
    statutoryPurpose: 'Section 15 CGST Act transaction value of product',
    description: 'Tax-exclusive base taxable turnover of goods.'
  },
  shippingAmountBasis: {
    canonicalField: 'shippingAmountBasis',
    primaryHeader: 'Shipping Amount Basis',
    aliases: ['Shipping Amount Basis'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central GST Help Reference',
    statutoryPurpose: 'Section 8 composite supply ancillary freight charge',
    description: 'Tax-exclusive base for freight / shipping charges.'
  },
  giftWrapAmountBasis: {
    canonicalField: 'giftWrapAmountBasis',
    primaryHeader: 'Gift Wrap Amount Basis',
    aliases: ['Gift Wrap Amount Basis'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central GST Help Reference',
    statutoryPurpose: 'Section 8 composite supply ancillary packaging charge',
    description: 'Tax-exclusive base for gift packaging.'
  },
  itemPromoDiscountBasis: {
    canonicalField: 'itemPromoDiscountBasis',
    primaryHeader: 'Item Promo Discount Basis',
    aliases: ['Item Promo Discount Basis'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central GST Help Reference',
    statutoryPurpose: 'Section 15(3)(a) discount allowed before or at time of supply',
    description: 'Tax-exclusive discount deducted on the product.'
  },
  shippingPromoDiscountBasis: {
    canonicalField: 'shippingPromoDiscountBasis',
    primaryHeader: 'Shipping Promo Discount Basis',
    aliases: ['Shipping Promo Discount Basis'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central GST Help Reference',
    statutoryPurpose: 'Section 15(3)(a) discount allowed on shipping charges',
    description: 'Tax-exclusive discount deducted on freight.'
  },
  giftWrapPromoDiscountBasis: {
    canonicalField: 'giftWrapPromoDiscountBasis',
    primaryHeader: 'Gift Wrap Promo Discount Basis',
    aliases: ['Gift Wrap Promo Discount Basis'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central GST Help Reference',
    statutoryPurpose: 'Section 15(3)(a) discount allowed on gift wrap charges',
    description: 'Tax-exclusive promotional discount deducted on packaging.'
  },
  taxExclusiveGross: {
    canonicalField: 'taxExclusiveGross',
    primaryHeader: 'Tax Exclusive Gross',
    aliases: ['Tax Exclusive Gross'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central GST Help Reference',
    statutoryPurpose: 'Cumulative net taxable turnover across all lines',
    description: 'Net taxable base across item, shipping, wrap, and discounts.'
  },
  cgstRate: {
    canonicalField: 'cgstRate',
    primaryHeader: 'CGST Rate',
    aliases: ['CGST Rate'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central GST Help Reference',
    statutoryPurpose: 'Statutory Central GST tax rate',
    description: 'Central GST percentage applicable to supply (e.g. 0.09, 0.025).'
  },
  cgstAmount: {
    canonicalField: 'cgstAmount',
    primaryHeader: 'CGST Amount',
    aliases: ['CGST Amount'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central GST Help Reference',
    statutoryPurpose: 'Section 9 CGST Act output central tax',
    description: 'Reported Central GST monetary amount.'
  },
  sgstRate: {
    canonicalField: 'sgstRate',
    primaryHeader: 'SGST Rate',
    aliases: ['SGST Rate'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central GST Help Reference',
    statutoryPurpose: 'Statutory State GST tax rate',
    description: 'State GST percentage applicable to supply (e.g. 0.09, 0.025).'
  },
  sgstAmount: {
    canonicalField: 'sgstAmount',
    primaryHeader: 'SGST Amount',
    aliases: ['SGST Amount'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central GST Help Reference',
    statutoryPurpose: 'Section 9 SGST Act output state tax',
    description: 'Reported State GST monetary amount.'
  },
  utgstRate: {
    canonicalField: 'utgstRate',
    primaryHeader: 'UTGST Rate',
    aliases: ['UTGST Rate'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central GST Help Reference',
    statutoryPurpose: 'Statutory Union Territory GST tax rate',
    description: 'Union Territory GST percentage applicable to supply.'
  },
  utgstAmount: {
    canonicalField: 'utgstAmount',
    primaryHeader: 'UTGST Amount',
    aliases: ['UTGST Amount'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central GST Help Reference',
    statutoryPurpose: 'Section 7 UTGST Act output union territory tax',
    description: 'Reported Union Territory GST monetary amount.'
  },
  igstRate: {
    canonicalField: 'igstRate',
    primaryHeader: 'IGST Rate',
    aliases: ['IGST Rate'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central GST Help Reference',
    statutoryPurpose: 'Statutory Integrated GST tax rate',
    description: 'Integrated GST percentage applicable to supply (e.g. 0.18, 0.12).'
  },
  igstAmount: {
    canonicalField: 'igstAmount',
    primaryHeader: 'IGST Amount',
    aliases: ['IGST Amount'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central GST Help Reference',
    statutoryPurpose: 'Section 5 IGST Act output integrated tax',
    description: 'Reported Integrated GST monetary amount.'
  },
  cessAmount: {
    canonicalField: 'cessAmount',
    primaryHeader: 'Compensatory Cess Amount',
    aliases: ['Compensatory Cess Amount'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central GST Help Reference',
    statutoryPurpose: 'GST (Compensation to States) Act output cess',
    description: 'Reported compensatory cess amount.'
  },
  totalTaxAmount: {
    canonicalField: 'totalTaxAmount',
    primaryHeader: 'Total Tax Amount',
    aliases: ['Total Tax Amount'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central GST Help Reference',
    statutoryPurpose: 'Total statutory output tax sum',
    description: 'Cumulative tax across CGST, SGST, UTGST, IGST, and Cess.'
  },
  invoiceAmount: {
    canonicalField: 'invoiceAmount',
    primaryHeader: 'Invoice Amount',
    aliases: ['Invoice Amount', 'Invoice Value'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central GST Help Reference',
    statutoryPurpose: 'Gross commercial invoice total',
    description: 'Total tax-inclusive monetary value of supply.'
  },
  tcsCgstAmount: {
    canonicalField: 'tcsCgstAmount',
    primaryHeader: 'TCS CGST Amount',
    aliases: ['TCS CGST Amount'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central GST Help Reference',
    statutoryPurpose: 'Section 52 CGST Act central tax collected at source',
    description: 'Central TCS withheld by marketplace.'
  },
  tcsSgstAmount: {
    canonicalField: 'tcsSgstAmount',
    primaryHeader: 'TCS SGST Amount',
    aliases: ['TCS SGST Amount'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central GST Help Reference',
    statutoryPurpose: 'Section 52 SGST Act state tax collected at source',
    description: 'State TCS withheld by marketplace.'
  },
  tcsIgstAmount: {
    canonicalField: 'tcsIgstAmount',
    primaryHeader: 'TCS IGST Amount',
    aliases: ['TCS IGST Amount'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central GST Help Reference',
    statutoryPurpose: 'Section 52 IGST Act integrated tax collected at source',
    description: 'Integrated TCS withheld by marketplace.'
  },
  fulfillmentChannel: {
    canonicalField: 'fulfillmentChannel',
    primaryHeader: 'Fulfillment Channel',
    aliases: ['Fulfillment Channel'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central Tax Document Library',
    statutoryPurpose: 'Logistics channel distinction (AFN/FBA vs MFN/Merchant)',
    description: 'Indicates Amazon Fulfilled Network (AFN) or Merchant Fulfilled Network (MFN).'
  },
  warehouseId: {
    canonicalField: 'warehouseId',
    primaryHeader: 'Warehouse ID',
    aliases: ['Warehouse ID', 'Ship From FC', 'Ship From Fc'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central Tax Document Library & STR Schema',
    statutoryPurpose: 'Physical fulfillment center dispatch site',
    description: 'Amazon fulfillment center identifier (e.g. BOM5, DEL4).'
  },
  irnNumber: {
    canonicalField: 'irnNumber',
    primaryHeader: 'Irn Number',
    aliases: ['Irn Number', 'IRN Number'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central STR Schema & E-Invoicing Rules',
    statutoryPurpose: 'Rule 48(4) CGST Rules Invoice Reference Number',
    description: '64-character hash registered on Invoice Registration Portal (IRP).'
  },
  irnStatus: {
    canonicalField: 'irnStatus',
    primaryHeader: 'Irn Filing Status',
    aliases: ['Irn Filing Status', 'IRN Filing Status'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central STR Schema',
    statutoryPurpose: 'E-invoicing compliance validation',
    description: 'Government IRP registration status (e.g. GOVT_ACCEPT, SUCCESS).'
  },
  irnDate: {
    canonicalField: 'irnDate',
    primaryHeader: 'Irn Date',
    aliases: ['Irn Date', 'IRN Date'],
    classification: MappingEvidence.DOCUMENTATION_VERIFIED,
    docSource: 'Amazon Seller Central STR Schema',
    statutoryPurpose: 'IRP acknowledgment timestamp',
    description: 'Date and time of IRN generation on government portal.'
  }
};
