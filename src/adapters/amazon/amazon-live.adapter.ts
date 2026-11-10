import fs from 'node:fs';
import crypto from 'node:crypto';
import { parse } from 'csv-parse';
import { Decimal } from '../../utils/decimal.js';
import { parseISODateStrict, getFinancialYear } from '../../utils/date.js';
import { INDIAN_STATE_CODES, isValidStateCode, extractPANFromGSTIN } from '../../utils/state-codes.js';
import {
  NormalizedRecord,
  OutwardSupplyRecord,
  CreditNoteRecord,
  StockTransferRecord,
  CancelledOrderRecord,
  MalformedRecord,
  SourceReference,
  ValidationIssue,
  TaxBreakdown
} from '../../models/transaction.schema.js';
import {
  RecipientType,
  SupplyType,
  IssueSeverity,
  IssueCode,
  ReconciliationStatus,
  StockTransferClassification
} from '../../models/enums.js';
import {
  AmazonMtrLiveAdapterOptions,
  AmazonMtrMetadata,
  CanonicalAmazonField,
  LiveSourceProvenance,
  ThreeTierAmount,
  AmazonReportFormat,
  AmazonHeaderVersion
} from './amazon-live.types.js';
import { HeaderAliasResolver } from './amazon-live-header-resolver.js';

export class AmazonMtrLiveAdapter {
  private aliasResolver: HeaderAliasResolver;
  private options: AmazonMtrLiveAdapterOptions;

  constructor(options: AmazonMtrLiveAdapterOptions) {
    this.options = options;
    this.aliasResolver = new HeaderAliasResolver({
      enableTier3Unverified: options.enableTier3Unverified ?? false,
      customOverrides: options.headerOverrides
    });
  }

  /**
   * Helper to safely create a ThreeTierAmount from an unparsed raw CSV string.
   */
  public static parseThreeTierAmount(rawText: string | undefined): ThreeTierAmount | undefined {
    if (rawText === undefined || rawText === null || rawText.trim() === '') {
      return undefined;
    }
    const trimmed = rawText.trim();
    try {
      const signedAmount = new Decimal(trimmed);
      return {
        rawText: trimmed,
        signedAmount,
        normalizedMagnitude: signedAmount.abs()
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Computes SHA-256 fingerprint of a file.
   */
  public static computeFileFingerprint(filePath: string): string {
    const fileBuffer = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(fileBuffer).digest('hex');
  }

  /**
   * Streams and normalizes live Amazon MTR CSV records on the fly.
   */
  public async *streamRecords(filePath: string): AsyncGenerator<NormalizedRecord> {
    const fileFingerprint = AmazonMtrLiveAdapter.computeFileFingerprint(filePath);
    const importBatchId = this.options.importBatchId || crypto.randomUUID();
    const sourceReport = this.options.sourceReportName || filePath;

    const fileStream = fs.createReadStream(filePath);
    let parser: any = null;

    try {
      parser = fileStream.pipe(
        parse({
          columns: (headers: string[]) => this.aliasResolver.mapHeaderRow(headers),
          skip_empty_lines: true,
          relax_column_count: true,
          relax_quotes: true,
          trim: true,
          info: true
        })
      );

      let logicalRecordNumber = 0;

      for await (const { record, info } of parser) {
        logicalRecordNumber++;
        const physicalLineNumber = info.lines;

        const provenance: LiveSourceProvenance = {
          sourceReport,
          fileFingerprint,
          importBatchId,
          physicalLineNumber,
          logicalRecordNumber
        };

        const normalized = this.processRow(record, provenance);
        yield normalized;
      }
    } finally {
      if (fileStream && !fileStream.destroyed) {
        fileStream.destroy();
      }
      if (parser && !parser.destroyed) {
        parser.destroy();
      }
    }
  }

  /**
   * Ingests the entire file into an array of NormalizedRecord.
   */
  public async parseFile(filePath: string): Promise<NormalizedRecord[]> {
    const records: NormalizedRecord[] = [];
    for await (const record of this.streamRecords(filePath)) {
      records.push(record);
    }
    return records;
  }

  private processRow(
    row: Record<string, string>,
    provenance: LiveSourceProvenance
  ): NormalizedRecord {
    const rawType = (row.transactionType || '').trim().toLowerCase();
    const creditNoteNum = (row.creditNoteNumber || '').trim();

    // Composite documentary evidence for classification
    const hasExplicitRefundType = rawType === 'refund' || rawType === 'return' || rawType === 'credit note';
    const hasCreditNoteIdentifier = creditNoteNum.length > 0;
    const isPreDispatchCancel = rawType === 'cancel' || rawType === 'cancelled';
    const isExplicitShipment = rawType === 'shipment' || rawType === 'sale';

    // Three-tier financial parsing
    const principalBasis = AmazonMtrLiveAdapter.parseThreeTierAmount(row.principalAmountBasis);
    const shippingBasis = AmazonMtrLiveAdapter.parseThreeTierAmount(row.shippingAmountBasis);
    const giftWrapBasis = AmazonMtrLiveAdapter.parseThreeTierAmount(row.giftWrapAmountBasis);
    const itemPromoBasis = AmazonMtrLiveAdapter.parseThreeTierAmount(row.itemPromoDiscountBasis);
    const shippingPromoBasis = AmazonMtrLiveAdapter.parseThreeTierAmount(row.shippingPromoDiscountBasis);
    const giftWrapPromoBasis = AmazonMtrLiveAdapter.parseThreeTierAmount(row.giftWrapPromoDiscountBasis);
    const taxExclusiveGross = AmazonMtrLiveAdapter.parseThreeTierAmount(row.taxExclusiveGross);
    const totalTax = AmazonMtrLiveAdapter.parseThreeTierAmount(row.totalTaxAmount);
    const invoiceAmt = AmazonMtrLiveAdapter.parseThreeTierAmount(row.invoiceAmount);

    const isSignedNegative =
      (principalBasis && principalBasis.signedAmount.isNegative()) ||
      (invoiceAmt && invoiceAmt.signedAmount.isNegative()) ||
      (taxExclusiveGross && taxExclusiveGross.signedAmount.isNegative());

    // Construct Amazon-specific metadata
    const metadata: AmazonMtrMetadata = {
      provenance,
      reportFormat: this.aliasResolver.getReportFormat(),
      headerVersion: this.aliasResolver.getHeaderVersion(),
      unknownColumns: this.aliasResolver.getUnknownHeaders(),
      principalAmountBasis: principalBasis,
      shippingAmountBasis: shippingBasis,
      giftWrapAmountBasis: giftWrapBasis,
      itemPromoDiscountBasis: itemPromoBasis,
      shippingPromoDiscountBasis: shippingPromoBasis,
      giftWrapPromoDiscountBasis: giftWrapPromoBasis,
      taxExclusiveGross: taxExclusiveGross,
      totalTaxAmount: totalTax,
      invoiceAmount: invoiceAmt,
      reportedCgst: AmazonMtrLiveAdapter.parseThreeTierAmount(row.cgstAmount),
      reportedSgst: AmazonMtrLiveAdapter.parseThreeTierAmount(row.sgstAmount),
      reportedUtgst: AmazonMtrLiveAdapter.parseThreeTierAmount(row.utgstAmount),
      reportedIgst: AmazonMtrLiveAdapter.parseThreeTierAmount(row.igstAmount),
      reportedCess: AmazonMtrLiveAdapter.parseThreeTierAmount(row.cessAmount),
      reportedTcsCgst: AmazonMtrLiveAdapter.parseThreeTierAmount(row.tcsCgstAmount),
      reportedTcsSgst: AmazonMtrLiveAdapter.parseThreeTierAmount(row.tcsSgstAmount),
      reportedTcsIgst: AmazonMtrLiveAdapter.parseThreeTierAmount(row.tcsIgstAmount),
      fulfillmentChannel: row.fulfillmentChannel,
      warehouseId: row.warehouseId,
      asin: row.asin,
      productTaxCode: row.productTaxCode,
      irnNumber: row.irnNumber ? row.irnNumber.trim() : undefined,
      irnStatus: row.irnStatus ? row.irnStatus.trim() : undefined,
      irnDate: row.irnDate ? row.irnDate.trim() : undefined,
      evidenceFlags: {
        explicitRefundTag: hasExplicitRefundType,
        hasCreditNoteNumber: hasCreditNoteIdentifier,
        isSignedNegative: !!isSignedNegative,
        hasOriginalInvoiceRef: !!(row.invoiceNumber && row.invoiceNumber.trim()),
        isPreDispatchCancel
      }
    };

    const sourceRef: SourceReference = {
      sourceReport: provenance.sourceReport,
      sourceRowNumber: provenance.physicalLineNumber,
      rawRecord: {
        ...row,
        _amazonMtrMetadata: metadata
      }
    };

    // 1. Pre-dispatch cancellation
    if (isPreDispatchCancel) {
      return this.normalizeCancelledOrder(row, sourceRef, metadata);
    }

    // 2. Refund / Credit Note (Requires primary documentary evidence, NEVER sign alone)
    if (hasExplicitRefundType || hasCreditNoteIdentifier) {
      return this.normalizeCreditNote(row, sourceRef, metadata);
    }

    // 3. Stock Transfer (FC_TRANSFER, FC_REMOVAL, or Stock Transfer Report format)
    const isStockTransfer =
      rawType === 'fc_transfer' ||
      rawType === 'fc_removal' ||
      rawType === 'fc_removal-cancel' ||
      rawType === 'stock_transfer' ||
      rawType === 'stock transfer' ||
      this.aliasResolver.getReportFormat() === AmazonReportFormat.STOCK_TRANSFER;

    if (isStockTransfer) {
      return this.normalizeStockTransfer(row, sourceRef, metadata);
    }

    // 4. Outward Supply (Shipment)
    if (isExplicitShipment || (!rawType && row.invoiceNumber)) {
      return this.normalizeOutwardSupply(row, sourceRef, metadata, isSignedNegative);
    }

    // 5. Unrecognized transaction type -> Malformed
    const issues: ValidationIssue[] = [
      {
        code: 'MALFORMED_CSV_ROW',
        severity: IssueSeverity.ERROR,
        field: 'Transaction Type',
        message: `Unrecognized or missing transaction type '${row.transactionType || ''}'`,
        sourceRowNumber: provenance.physicalLineNumber,
        sourceReport: provenance.sourceReport
      }
    ];

    return {
      recordType: 'MALFORMED',
      id: `${provenance.sourceReport}#${provenance.physicalLineNumber}`,
      sourceRef,
      rawFields: row,
      errorSummary: `Unrecognized transaction type '${row.transactionType || ''}'`,
      issues
    };
  }

  private normalizeStockTransfer(
    row: Record<string, string>,
    sourceRef: SourceReference,
    metadata: AmazonMtrMetadata
  ): NormalizedRecord {
    const issues: ValidationIssue[] = [];
    const sourceReport = sourceRef.sourceReport;
    const sourceRowNumber = sourceRef.sourceRowNumber;

    const transferInvoiceNumber = (row.invoiceNumber || row.orderId || `STR-${sourceRowNumber}`).trim();
    let transferDate = new Date();
    if (row.invoiceDate) {
      const parsed = parseISODateStrict(row.invoiceDate);
      if (parsed) {
        transferDate = parsed;
      }
    }

    const sourceGstin = (row.sellerGstin || '').trim().toUpperCase();
    const destinationGstin = (row.customerShipToGstin || row.customerBillToGstin || '').trim().toUpperCase();

    const sourcePan = (extractPANFromGSTIN(sourceGstin) || 'XXXXXXXXXX').slice(0, 10);
    const destinationPan = (extractPANFromGSTIN(destinationGstin) || 'XXXXXXXXXX').slice(0, 10);

    const shipFromStateCode = this.resolveStateCode(row.shipFromState) || (sourceGstin.length >= 2 ? sourceGstin.slice(0, 2) : '99');
    const shipToStateCode = this.resolveStateCode(row.shipToState) || (destinationGstin.length >= 2 ? destinationGstin.slice(0, 2) : '99');

    let classification = StockTransferClassification.UNKNOWN;
    if (sourcePan !== 'XXXXXXXXXX' && destinationPan !== 'XXXXXXXXXX' && sourcePan === destinationPan && sourceGstin !== destinationGstin) {
      classification = StockTransferClassification.DISTINCT_PERSON_SUPPLY;
    } else if (sourcePan !== 'XXXXXXXXXX' && destinationPan !== 'XXXXXXXXXX' && sourcePan !== destinationPan) {
      classification = StockTransferClassification.INTER_COMPANY_SUPPLY;
    } else {
      classification = StockTransferClassification.REVIEW_REQUIRED;
      issues.push({
        code: IssueCode.STOCK_TRANSFER_REVIEW_REQUIRED,
        severity: IssueSeverity.REVIEW,
        field: 'Classification',
        message: 'Stock transfer relationship could not be verified; routed to Review',
        sourceRowNumber,
        sourceReport
      });
    }

    const principalMag = metadata.principalAmountBasis
      ? metadata.principalAmountBasis.normalizedMagnitude
      : metadata.taxExclusiveGross
      ? metadata.taxExclusiveGross.normalizedMagnitude
      : new Decimal(0);

    const igstAmount = metadata.reportedIgst ? metadata.reportedIgst.normalizedMagnitude : new Decimal(0);
    const cgstAmount = metadata.reportedCgst ? metadata.reportedCgst.normalizedMagnitude : new Decimal(0);
    const sgstAmount = metadata.reportedSgst ? metadata.reportedSgst.normalizedMagnitude : new Decimal(0);
    const utgstAmount = metadata.reportedUtgst ? metadata.reportedUtgst.normalizedMagnitude : new Decimal(0);
    const cessAmount = metadata.reportedCess ? metadata.reportedCess.normalizedMagnitude : new Decimal(0);

    const taxBreakdown: TaxBreakdown = {
      taxableValue: principalMag,
      shippingTaxableValue: new Decimal(0),
      totalTaxableValue: principalMag,
      taxRate: row.igstRate || row.cgstRate ? new Decimal((row.igstRate || row.cgstRate || '0').trim()) : new Decimal(0),
      cgstRate: row.cgstRate ? new Decimal(row.cgstRate.trim()) : new Decimal(0),
      cgstAmount,
      sgstRate: row.sgstRate ? new Decimal(row.sgstRate.trim()) : new Decimal(0),
      sgstAmount,
      utgstRate: row.utgstRate ? new Decimal(row.utgstRate.trim()) : new Decimal(0),
      utgstAmount,
      igstRate: row.igstRate ? new Decimal(row.igstRate.trim()) : new Decimal(0),
      igstAmount,
      cessAmount,
      totalInvoiceAmount: metadata.invoiceAmount
        ? metadata.invoiceAmount.normalizedMagnitude
        : principalMag.add(igstAmount).add(cgstAmount).add(sgstAmount).add(utgstAmount).add(cessAmount)
    };

    const record: StockTransferRecord = {
      recordType: 'STOCK_TRANSFER',
      id: `${sourceReport}#${sourceRowNumber}`,
      sourceRef,
      transferInvoiceNumber,
      transferDate,
      financialYear: getFinancialYear(transferDate),
      sourceGstin,
      destinationGstin,
      sourcePan,
      destinationPan,
      classification,
      shipFromStateCode,
      shipToStateCode,
      hsnSac: row.hsnSac ? row.hsnSac.trim() : undefined,
      quantity: row.quantity ? parseInt(row.quantity.trim(), 10) : 1,
      taxBreakdown,
      issues
    };

    return record;
  }

  private normalizeOutwardSupply(
    row: Record<string, string>,
    sourceRef: SourceReference,
    metadata: AmazonMtrMetadata,
    isSignedNegative: boolean | undefined
  ): NormalizedRecord {
    const issues: ValidationIssue[] = [];
    const sourceReport = sourceRef.sourceReport;
    const sourceRowNumber = sourceRef.sourceRowNumber;

    // Check mandatory fields
    const invoiceNumber = (row.invoiceNumber || '').trim();
    if (!invoiceNumber) {
      issues.push({
        code: IssueCode.MISSING_INVOICE_NUMBER,
        severity: IssueSeverity.ERROR,
        field: 'Invoice Number',
        message: 'Mandatory invoice number is missing',
        sourceRowNumber,
        sourceReport
      });
    }

    const sellerGstin = (row.sellerGstin || '').trim().toUpperCase();
    if (!sellerGstin) {
      issues.push({
        code: IssueCode.MISSING_FIELD,
        severity: IssueSeverity.ERROR,
        field: 'Seller GSTIN',
        message: 'Mandatory Seller GSTIN is missing',
        sourceRowNumber,
        sourceReport
      });
    } else if (this.options.expectedSellerGstin && sellerGstin !== this.options.expectedSellerGstin) {
      issues.push({
        code: IssueCode.BUYER_GSTIN_MISMATCH,
        severity: IssueSeverity.REVIEW,
        field: 'Seller GSTIN',
        message: `Seller GSTIN '${sellerGstin}' does not match organization GSTIN '${this.options.expectedSellerGstin}'`,
        sourceRowNumber,
        sourceReport
      });
    }

    // Deterministic invoice date parsing
    let invoiceDate = new Date();
    if (row.invoiceDate) {
      const parsed = parseISODateStrict(row.invoiceDate);
      if (parsed) {
        invoiceDate = parsed;
      } else {
        issues.push({
          code: IssueCode.INVALID_INVOICE_DATE,
          severity: IssueSeverity.ERROR,
          field: 'Invoice Date',
          message: `Invalid invoice date string: '${row.invoiceDate}'`,
          sourceRowNumber,
          sourceReport
        });
      }
    }

    const financialYear = getFinancialYear(invoiceDate);

    // Recipient & POS Determination (Section 10(1)(a), 10(1)(b), 10(1)(ca))
    const customerGstin = (row.customerBillToGstin || row.customerShipToGstin || '').trim().toUpperCase() || undefined;
    const recipientType = customerGstin ? RecipientType.B2B : RecipientType.B2C;

    const shipFromStateCode = this.resolveStateCode(row.shipFromState);
    let placeOfSupplyStateCode = this.resolveStateCode(row.placeOfSupply);

    if (!placeOfSupplyStateCode) {
      if (recipientType === RecipientType.B2B) {
        if (customerGstin && isValidStateCode(customerGstin.slice(0, 2))) {
          // Section 10(1)(b): Bill-To controls Place of Supply on tripartite business orders
          placeOfSupplyStateCode = customerGstin.slice(0, 2);
        } else {
          // Section 10(1)(b) requirement: B2B without valid buyer GSTIN state code cannot fallback to shipping state
          issues.push({
            code: IssueCode.B2B_WITHOUT_GSTIN,
            severity: IssueSeverity.REVIEW,
            field: 'Customer Bill to GSTIN',
            message: 'B2B supply missing valid buyer GSTIN state code; routed to Exception Review under Section 10(1)(b)',
            sourceRowNumber,
            sourceReport
          });
          placeOfSupplyStateCode = this.resolveStateCode(row.shipToState) || shipFromStateCode || '99';
        }
      } else {
        // B2C logic: Section 10(1)(a) pre-Oct 2023 vs Section 10(1)(ca) post-Oct 2023 & Circular 209/03/2024-GST
        const isPostOctober2023 = invoiceDate >= new Date('2023-10-01T00:00:00Z');
        if (row.shipToState) {
          placeOfSupplyStateCode = this.resolveStateCode(row.shipToState) || '99';
        } else if (isPostOctober2023 && shipFromStateCode) {
          // Circular 209/03/2024-GST: If delivery address missing on invoice, defaults to supplier location
          placeOfSupplyStateCode = shipFromStateCode;
        } else {
          placeOfSupplyStateCode = shipFromStateCode || '99';
          issues.push({
            code: IssueCode.POS_MISMATCH,
            severity: IssueSeverity.REVIEW,
            field: 'Place of Supply',
            message: 'Insufficient address evidence for B2C place of supply determination; routed to Review',
            sourceRowNumber,
            sourceReport
          });
        }
      }
    }

    const supplyType =
      shipFromStateCode === placeOfSupplyStateCode ? SupplyType.INTRASTATE : SupplyType.INTERSTATE;

    // Financial calculations: NO SILENT SUBSTITUTION!
    if (!metadata.principalAmountBasis) {
      issues.push({
        code: IssueCode.MISSING_FIELD,
        severity: IssueSeverity.ERROR,
        field: 'Principal Amount Basis',
        message: 'Mandatory Principal Amount Basis is missing; silent substitution from Tax Exclusive Gross is prohibited',
        sourceRowNumber,
        sourceReport
      });
    }

    const principalMag = metadata.principalAmountBasis ? metadata.principalAmountBasis.normalizedMagnitude : new Decimal(0);
    const itemPromoMag = metadata.itemPromoDiscountBasis ? metadata.itemPromoDiscountBasis.normalizedMagnitude : new Decimal(0);
    const netItemTaxable = Decimal.max(new Decimal(0), principalMag.sub(itemPromoMag));

    const shippingMag = metadata.shippingAmountBasis ? metadata.shippingAmountBasis.normalizedMagnitude : new Decimal(0);
    const shippingPromoMag = metadata.shippingPromoDiscountBasis ? metadata.shippingPromoDiscountBasis.normalizedMagnitude : new Decimal(0);
    const netShippingTaxable = Decimal.max(new Decimal(0), shippingMag.sub(shippingPromoMag));

    const totalTaxable = netItemTaxable.add(netShippingTaxable);

    // Extract reported tax components
    const cgstAmount = metadata.reportedCgst ? metadata.reportedCgst.normalizedMagnitude : new Decimal(0);
    const sgstAmount = metadata.reportedSgst ? metadata.reportedSgst.normalizedMagnitude : new Decimal(0);
    const utgstAmount = metadata.reportedUtgst ? metadata.reportedUtgst.normalizedMagnitude : new Decimal(0);
    const igstAmount = metadata.reportedIgst ? metadata.reportedIgst.normalizedMagnitude : new Decimal(0);
    const cessAmount = metadata.reportedCess ? metadata.reportedCess.normalizedMagnitude : new Decimal(0);

    const taxBreakdown: TaxBreakdown = {
      taxableValue: netItemTaxable,
      shippingTaxableValue: netShippingTaxable,
      totalTaxableValue: totalTaxable,
      taxRate: row.cgstRate || row.igstRate ? new Decimal((row.igstRate || row.cgstRate || '0').trim()) : new Decimal(0),
      cgstRate: row.cgstRate ? new Decimal(row.cgstRate.trim()) : new Decimal(0),
      cgstAmount,
      sgstRate: row.sgstRate ? new Decimal(row.sgstRate.trim()) : new Decimal(0),
      sgstAmount,
      utgstRate: row.utgstRate ? new Decimal(row.utgstRate.trim()) : new Decimal(0),
      utgstAmount,
      igstRate: row.igstRate ? new Decimal(row.igstRate.trim()) : new Decimal(0),
      igstAmount,
      cessAmount,
      totalInvoiceAmount: metadata.invoiceAmount ? metadata.invoiceAmount.normalizedMagnitude : totalTaxable.add(cgstAmount).add(sgstAmount).add(utgstAmount).add(igstAmount).add(cessAmount)
    };

    // Anomaly: Negative shipment amount is NOT fatal malformed; it routes to EXCEPTION_REVIEW
    if (isSignedNegative) {
      issues.push({
        code: IssueCode.NEGATIVE_TAXABLE_VALUE,
        severity: IssueSeverity.REVIEW,
        field: 'Principal Amount Basis',
        message: 'Shipment record carries negative financial amount; routed to Exception Review for practitioner investigation',
        sourceRowNumber,
        sourceReport,
        suggestedAction: 'Verify whether transaction represents a return rebate or post-dispatch adjustment'
      });
    }

    // Inconsistent tax component detection: Intrastate with IGST or Interstate with CGST/SGST
    if (supplyType === SupplyType.INTRASTATE && igstAmount.greaterThan(0)) {
      issues.push({
        code: IssueCode.INTRASTATE_WITH_IGST,
        severity: IssueSeverity.REVIEW,
        field: 'IGST Amount',
        message: `Intrastate supply from ${shipFromStateCode || 'origin'} to ${placeOfSupplyStateCode || 'destination'} reports IGST instead of CGST/SGST`,
        sourceRowNumber,
        sourceReport
      });
    } else if (supplyType === SupplyType.INTERSTATE && (cgstAmount.greaterThan(0) || sgstAmount.greaterThan(0))) {
      issues.push({
        code: IssueCode.INTERSTATE_WITH_CGST_SGST,
        severity: IssueSeverity.REVIEW,
        field: 'CGST/SGST Amount',
        message: `Interstate supply from ${shipFromStateCode || 'origin'} to ${placeOfSupplyStateCode || 'destination'} reports CGST/SGST instead of IGST`,
        sourceRowNumber,
        sourceReport
      });
    }

    const record: OutwardSupplyRecord = {
      recordType: 'OUTWARD_SUPPLY',
      id: `${sourceReport}#${sourceRowNumber}`,
      sourceRef,
      sellerGstin,
      customerGstin,
      invoiceNumber,
      invoiceDate,
      financialYear,
      orderId: (row.orderId || '').trim(),
      shipmentId: row.shipmentId ? row.shipmentId.trim() : undefined,
      sku: row.sku ? row.sku.trim() : undefined,
      asin: row.asin ? row.asin.trim() : undefined,
      hsnSac: row.hsnSac ? row.hsnSac.trim() : undefined,
      quantity: row.quantity ? parseInt(row.quantity.trim(), 10) : 1,
      productCategory: row.productTaxCode,
      shipFromStateCode: shipFromStateCode || '99',
      placeOfSupplyStateCode,
      supplyType,
      recipientType,
      taxBreakdown,
      currency: 'INR',
      issues
    };

    return record;
  }

  private normalizeCreditNote(
    row: Record<string, string>,
    sourceRef: SourceReference,
    metadata: AmazonMtrMetadata
  ): NormalizedRecord {
    const issues: ValidationIssue[] = [];
    const sourceReport = sourceRef.sourceReport;
    const sourceRowNumber = sourceRef.sourceRowNumber;

    const creditNoteNumber = (row.creditNoteNumber || row.invoiceNumber || '').trim();
    if (!creditNoteNumber) {
      issues.push({
        code: IssueCode.MISSING_FIELD,
        severity: IssueSeverity.ERROR,
        field: 'Credit Note Number',
        message: 'Credit note identifier is missing',
        sourceRowNumber,
        sourceReport
      });
    }

    let creditNoteDate = new Date();
    if (row.creditNoteDate || row.invoiceDate) {
      const parsed = parseISODateStrict(row.creditNoteDate || row.invoiceDate);
      if (parsed) {
        creditNoteDate = parsed;
      }
    }

    const sellerGstin = (row.sellerGstin || '').trim().toUpperCase();
    if (!sellerGstin) {
      issues.push({
        code: IssueCode.MISSING_FIELD,
        severity: IssueSeverity.ERROR,
        field: 'Seller GSTIN',
        message: 'Mandatory Seller GSTIN is missing',
        sourceRowNumber,
        sourceReport
      });
    } else if (this.options.expectedSellerGstin && sellerGstin !== this.options.expectedSellerGstin) {
      issues.push({
        code: IssueCode.BUYER_GSTIN_MISMATCH,
        severity: IssueSeverity.REVIEW,
        field: 'Seller GSTIN',
        message: `Seller GSTIN '${sellerGstin}' does not match organization GSTIN '${this.options.expectedSellerGstin}'`,
        sourceRowNumber,
        sourceReport
      });
    }

    const customerGstin = (row.customerBillToGstin || row.customerShipToGstin || '').trim().toUpperCase() || undefined;
    const recipientType = customerGstin ? RecipientType.B2B : RecipientType.B2C;

    const originalInvoiceNumber = row.invoiceNumber ? row.invoiceNumber.trim() : undefined;
    if (!originalInvoiceNumber) {
      issues.push({
        code: IssueCode.ORPHAN_CREDIT_NOTE,
        severity: IssueSeverity.REVIEW,
        field: 'Invoice Number',
        message: 'Credit note has no original invoice reference; cannot be matched automatically',
        sourceRowNumber,
        sourceReport
      });
    }

    // Use normalized positive magnitudes for domain schema compliance
    const taxableReversal = metadata.principalAmountBasis
      ? metadata.principalAmountBasis.normalizedMagnitude
      : metadata.taxExclusiveGross
      ? metadata.taxExclusiveGross.normalizedMagnitude
      : new Decimal(0);

    const cgstReversal = metadata.reportedCgst ? metadata.reportedCgst.normalizedMagnitude : new Decimal(0);
    const sgstReversal = metadata.reportedSgst ? metadata.reportedSgst.normalizedMagnitude : new Decimal(0);
    const utgstReversal = metadata.reportedUtgst ? metadata.reportedUtgst.normalizedMagnitude : new Decimal(0);
    const igstReversal = metadata.reportedIgst ? metadata.reportedIgst.normalizedMagnitude : new Decimal(0);
    const creditNoteTotal = metadata.invoiceAmount
      ? metadata.invoiceAmount.normalizedMagnitude
      : taxableReversal.add(cgstReversal).add(sgstReversal).add(utgstReversal).add(igstReversal);

    const pos = this.resolveStateCode(row.placeOfSupply || row.shipToState);
    const originState = this.resolveStateCode(row.shipFromState) || (sellerGstin.length >= 2 ? sellerGstin.slice(0, 2) : undefined);
    if (pos && originState) {
      const isIntra = pos === originState;
      if (isIntra && igstReversal.greaterThan(0)) {
        issues.push({
          code: IssueCode.INTRASTATE_WITH_IGST,
          severity: IssueSeverity.REVIEW,
          field: 'IGST Amount',
          message: `Intrastate refund reversal from ${originState} to ${pos} reports IGST instead of CGST/SGST`,
          sourceRowNumber,
          sourceReport
        });
      } else if (!isIntra && (cgstReversal.greaterThan(0) || sgstReversal.greaterThan(0))) {
        issues.push({
          code: IssueCode.INTERSTATE_WITH_CGST_SGST,
          severity: IssueSeverity.REVIEW,
          field: 'CGST/SGST Amount',
          message: `Interstate refund reversal from ${originState} to ${pos} reports CGST/SGST instead of IGST`,
          sourceRowNumber,
          sourceReport
        });
      }
    }

    const record: CreditNoteRecord = {
      recordType: 'CREDIT_NOTE',
      id: `${sourceReport}#${sourceRowNumber}`,
      sourceRef,
      creditNoteNumber,
      creditNoteDate,
      originalInvoiceNumber: row.invoiceNumber ? row.invoiceNumber.trim() : undefined,
      financialYear: getFinancialYear(creditNoteDate),
      orderId: row.orderId ? row.orderId.trim() : undefined,
      recipientType,
      sellerGstin,
      customerGstin,
      placeOfSupplyStateCode: this.resolveStateCode(row.placeOfSupply || row.shipToState),
      hsnSac: row.hsnSac ? row.hsnSac.trim() : undefined,
      taxableValueReversal: taxableReversal,
      cgstAmountReversal: cgstReversal,
      sgstAmountReversal: sgstReversal,
      utgstAmountReversal: utgstReversal,
      igstAmountReversal: igstReversal,
      creditNoteTotal,
      reconciliationStatus: ReconciliationStatus.UNMATCHED_ORPHAN,
      issues
    };

    return record;
  }

  private normalizeCancelledOrder(
    row: Record<string, string>,
    sourceRef: SourceReference,
    metadata: AmazonMtrMetadata
  ): CancelledOrderRecord {
    let orderDate: Date | undefined;
    if (row.invoiceDate) {
      orderDate = parseISODateStrict(row.invoiceDate) || undefined;
    }

    return {
      recordType: 'CANCELLED_ORDER',
      id: `${sourceRef.sourceReport}#${sourceRef.sourceRowNumber}`,
      sourceRef,
      orderId: (row.orderId || '').trim(),
      orderDate,
      sellerGstin: (row.sellerGstin || '').trim().toUpperCase() || undefined,
      customerGstin: (row.customerBillToGstin || row.customerShipToGstin || '').trim().toUpperCase() || undefined,
      reason: 'Pre-dispatch cancellation',
      createsTaxLiability: false,
      issues: []
    };
  }

  private static readonly ALPHA2_TO_NUMERIC: Record<string, string> = {
    JK: '01', HP: '02', PB: '03', CH: '04', UK: '05', UA: '05',
    HR: '06', DL: '07', RJ: '08', UP: '09', BR: '10', SK: '11',
    AR: '12', NL: '13', MN: '14', MZ: '15', TR: '16', ML: '17',
    AS: '18', WB: '19', JH: '20', OR: '21', OD: '21', CT: '22',
    CG: '22', MP: '23', GJ: '24', DD: '26', DN: '26', DH: '26',
    MH: '27', AP: '37', KA: '29', GA: '30', LD: '31', KL: '32',
    TN: '33', PY: '34', AN: '35', TS: '36', TG: '36', LA: '38',
    OT: '97'
  };

  private resolveStateCode(stateInput: string | undefined): string | undefined {
    if (!stateInput) return undefined;
    const trimmed = stateInput.trim().toUpperCase();
    if (isValidStateCode(trimmed)) return trimmed;
    if (AmazonMtrLiveAdapter.ALPHA2_TO_NUMERIC[trimmed]) {
      return AmazonMtrLiveAdapter.ALPHA2_TO_NUMERIC[trimmed];
    }
    const lower = trimmed.toLowerCase();
    const matched = Object.values(INDIAN_STATE_CODES).find(
      (s) => s.name.toLowerCase() === lower
    );
    return matched ? matched.code : undefined;
  }
}
