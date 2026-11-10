import {
  CanonicalAmazonField,
  UnsupportedReportFormatError,
  DuplicateCanonicalHeaderError,
  AmazonReportFormat,
  AmazonHeaderVersion
} from './amazon-live.types.js';

export const TIER1_VERIFIED_ALIASES: Record<CanonicalAmazonField, string[]> = {
  sellerGstin: ['Seller GSTIN', 'Seller GSTIN Number', 'Gstin Of Supplier'],
  invoiceNumber: ['Invoice Number', 'Tax Invoice No'],
  invoiceDate: ['Invoice Date', 'Tax Invoice Date'],
  transactionType: ['Transaction Type'],
  orderId: ['Order ID', 'Order Id'],
  shipmentId: ['Shipment ID', 'Shipment Id'],
  shipmentItemId: ['Shipment Item ID', 'Shipment Item Id'],
  creditNoteNumber: ['Credit Note No', 'Credit Note Number'],
  creditNoteDate: ['Credit Note Date'],
  asin: ['ASIN', 'Asin'],
  sku: ['SKU', 'Sku'],
  itemDescription: ['Item Description'],
  hsnSac: ['HSN/SAC', 'Hsn Code'],
  productTaxCode: ['Product Tax Code'],
  quantity: ['Quantity'],
  billFromCity: ['Bill From City'],
  billFromState: ['Bill From State'],
  shipFromState: ['Ship From State'],
  shipFromCity: ['Ship From City'],
  shipToState: ['Ship To State'],
  shipToCity: ['Ship To City'],
  customerBillToGstin: ['Customer Bill to GSTIN', 'Customer Bill-to GSTIN', 'Customer Bill To GSTIN'],
  customerShipToGstin: ['Customer Ship to GSTIN', 'Customer Ship-to GSTIN', 'Customer Ship To GSTIN', 'Gstin Of Receiver'],
  placeOfSupply: ['Place of Supply', 'Place Of Supply'],
  principalAmountBasis: ['Principal Amount Basis'],
  shippingAmountBasis: ['Shipping Amount Basis'],
  giftWrapAmountBasis: ['Gift Wrap Amount Basis'],
  itemPromoDiscountBasis: ['Item Promo Discount Basis'],
  shippingPromoDiscountBasis: ['Shipping Promo Discount Basis'],
  giftWrapPromoDiscountBasis: ['Gift Wrap Promo Discount Basis'],
  taxExclusiveGross: ['Tax Exclusive Gross'],
  cgstRate: ['CGST Rate'],
  cgstAmount: ['CGST Amount'],
  sgstRate: ['SGST Rate'],
  sgstAmount: ['SGST Amount'],
  utgstRate: ['UTGST Rate'],
  utgstAmount: ['UTGST Amount'],
  igstRate: ['IGST Rate'],
  igstAmount: ['IGST Amount'],
  cessAmount: ['Compensatory Cess Amount'],
  totalTaxAmount: ['Total Tax Amount'],
  invoiceAmount: ['Invoice Amount', 'Invoice Value'],
  tcsCgstAmount: ['TCS CGST Amount'],
  tcsSgstAmount: ['TCS SGST Amount'],
  tcsIgstAmount: ['TCS IGST Amount'],
  fulfillmentChannel: ['Fulfillment Channel'],
  warehouseId: ['Warehouse ID', 'Ship From FC', 'Ship From Fc'],
  irnNumber: ['Irn Number', 'IRN Number'],
  irnStatus: ['Irn Filing Status', 'IRN Filing Status'],
  irnDate: ['Irn Date', 'IRN Date']
};

export const TIER2_CONDITIONAL_ALIASES: Partial<Record<CanonicalAmazonField, string[]>> = {
  customerBillToGstin: ['Buyer GSTIN', 'BuyerGstin'],
  customerShipToGstin: ['Customer Ship To GSTIN'],
  placeOfSupply: ['POS State'],
  invoiceNumber: ['Invoice No', 'InvoiceNumber'],
  orderId: ['Amazon Order ID'],
  principalAmountBasis: ['Taxable Value'],
  invoiceAmount: ['Invoice Value']
};

export const TIER3_UNVERIFIED_ALIASES: Partial<Record<CanonicalAmazonField, string[]>> = {
  principalAmountBasis: ['Tax-Exclusive Principal Amount', 'Item Taxable Value', 'Principal Basis'],
  shippingAmountBasis: ['Tax-Exclusive Shipping Amount', 'Shipping Basis'],
  giftWrapAmountBasis: ['GiftWrap Basis'],
  invoiceAmount: ['Tax-Inclusive Gross', 'Total Amount'],
  shipmentItemId: ['OrderItemId'],
  sellerGstin: ['seller_gstin'],
  transactionType: ['TransactionType', 'Type']
};

export const MANDATORY_MTR_HEADERS: CanonicalAmazonField[] = [
  'sellerGstin',
  'invoiceNumber',
  'transactionType',
  'invoiceDate',
  'orderId'
];

export interface HeaderAliasResolverOptions {
  enableTier3Unverified?: boolean;
  customOverrides?: Partial<Record<CanonicalAmazonField, string[]>>;
  mandatoryHeaders?: CanonicalAmazonField[];
}

export class HeaderAliasResolver {
  private normalizedMap = new Map<string, CanonicalAmazonField>();
  private mandatoryHeaders: CanonicalAmazonField[];
  private detectedFormat: AmazonReportFormat = AmazonReportFormat.UNKNOWN;
  private detectedVersion: AmazonHeaderVersion = AmazonHeaderVersion.UNKNOWN_VERSION;
  private detectedUnknownHeaders: string[] = [];

  constructor(options: HeaderAliasResolverOptions = {}) {
    this.mandatoryHeaders = options.mandatoryHeaders || MANDATORY_MTR_HEADERS;
    this.buildLookupTable(options.enableTier3Unverified ?? false, options.customOverrides);
  }

  public getReportFormat(): AmazonReportFormat {
    return this.detectedFormat;
  }

  public getHeaderVersion(): AmazonHeaderVersion {
    return this.detectedVersion;
  }

  public getUnknownHeaders(): string[] {
    return [...this.detectedUnknownHeaders];
  }

  private static normalizeKey(text: string): string {
    return text
      .replace(/^\ufeff/, '') // Strip BOM
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }

  private buildLookupTable(
    enableTier3: boolean,
    customOverrides?: Partial<Record<CanonicalAmazonField, string[]>>
  ): void {
    // 1. Tier 1 Verified (highest default priority)
    for (const [canonical, aliases] of Object.entries(TIER1_VERIFIED_ALIASES) as [CanonicalAmazonField, string[]][]) {
      for (const alias of aliases) {
        this.normalizedMap.set(HeaderAliasResolver.normalizeKey(alias), canonical);
      }
    }

    // 2. Tier 2 Conditional
    for (const [canonical, aliases] of Object.entries(TIER2_CONDITIONAL_ALIASES) as [CanonicalAmazonField, string[]][]) {
      for (const alias of aliases) {
        const key = HeaderAliasResolver.normalizeKey(alias);
        if (!this.normalizedMap.has(key)) {
          this.normalizedMap.set(key, canonical);
        }
      }
    }

    // 3. Tier 3 Unverified (disabled by default)
    if (enableTier3) {
      for (const [canonical, aliases] of Object.entries(TIER3_UNVERIFIED_ALIASES) as [CanonicalAmazonField, string[]][]) {
        for (const alias of aliases) {
          const key = HeaderAliasResolver.normalizeKey(alias);
          if (!this.normalizedMap.has(key)) {
            this.normalizedMap.set(key, canonical);
          }
        }
      }
    }

    // 4. Custom overrides (highest caller priority)
    if (customOverrides) {
      for (const [canonical, aliases] of Object.entries(customOverrides) as [CanonicalAmazonField, string[]][]) {
        for (const alias of aliases) {
          this.normalizedMap.set(HeaderAliasResolver.normalizeKey(alias), canonical);
        }
      }
    }
  }

  /**
   * Resolves a single header string to its canonical field key, or returns undefined if unmapped.
   */
  public resolve(header: string): CanonicalAmazonField | undefined {
    const key = HeaderAliasResolver.normalizeKey(header);
    return this.normalizedMap.get(key);
  }

  /**
   * Transforms raw CSV headers into a positional array of strings.
   * Required signature for csv-parse columns callback: (headers: string[]) => string[]
   * Detects duplicate canonical mappings and validates mandatory headers.
   */
  public mapHeaderRow(rawHeaders: string[]): string[] {
    const mapped: string[] = [];
    const seenCanonical = new Map<CanonicalAmazonField, string>();
    this.detectedUnknownHeaders = [];

    for (const raw of rawHeaders) {
      const trimmed = raw.replace(/^\ufeff/, '').trim();
      const canonical = this.resolve(trimmed);

      if (canonical) {
        const existing = seenCanonical.get(canonical);
        if (existing) {
          throw new DuplicateCanonicalHeaderError(canonical, [existing, trimmed]);
        }
        seenCanonical.set(canonical, trimmed);
        mapped.push(canonical);
      } else {
        this.detectedUnknownHeaders.push(trimmed);
        mapped.push(trimmed);
      }
    }

    // Detect format and schema version from observed columns
    const hasSupplierGstin = rawHeaders.some((h) => HeaderAliasResolver.normalizeKey(h).includes('gstinofsupplier'));
    const hasReceiverGstin = rawHeaders.some((h) => HeaderAliasResolver.normalizeKey(h).includes('gstinofreceiver'));
    const hasShipFromFc = rawHeaders.some((h) => HeaderAliasResolver.normalizeKey(h).includes('shipfromfc'));

    if (hasSupplierGstin || hasReceiverGstin || hasShipFromFc) {
      this.detectedFormat = AmazonReportFormat.STOCK_TRANSFER;
      this.detectedVersion = AmazonHeaderVersion.STR_V1;
    } else if (seenCanonical.has('customerBillToGstin')) {
      this.detectedFormat = AmazonReportFormat.MTR_B2B;
      this.detectedVersion = AmazonHeaderVersion.V2021_POST_FEB;
    } else if (seenCanonical.has('customerShipToGstin')) {
      this.detectedFormat = AmazonReportFormat.MTR_B2B;
      this.detectedVersion = AmazonHeaderVersion.V2021_PRE_FEB;
    } else {
      this.detectedFormat = AmazonReportFormat.MTR_B2C;
      this.detectedVersion = AmazonHeaderVersion.V2021_POST_FEB;
    }

    // Validate mandatory headers
    const missing: CanonicalAmazonField[] = [];
    for (const required of this.mandatoryHeaders) {
      if (!seenCanonical.has(required)) {
        missing.push(required);
      }
    }

    if (missing.length > 0) {
      throw new UnsupportedReportFormatError(
        `File is not a supported Amazon MTR report. Missing mandatory headers: ${missing.join(', ')}`,
        missing,
        rawHeaders
      );
    }

    return mapped;
  }
}
