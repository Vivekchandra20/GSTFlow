import { Decimal, roundToTwo, toDecimal } from '../utils/decimal.js';
import { parseISODateStrict, getFinancialYear } from '../utils/date.js';
import { isValidStateCode } from '../utils/state-codes.js';
import { RawMarketplaceRecord } from '../adapters/base.adapter.js';
import {
  NormalizedRecord,
  OutwardSupplyRecord,
  CreditNoteRecord,
  StockTransferRecord,
  CancelledOrderRecord,
  MalformedRecord,
  ValidationIssue,
  TaxBreakdown,
  SourceReference
} from '../models/transaction.schema.js';
import {
  RecipientType,
  SupplyType,
  IssueSeverity,
  IssueCode,
  StockTransferClassification,
  ReconciliationStatus
} from '../models/enums.js';
import { CalculationPolicy, DEFAULT_CALCULATION_POLICY, GSTCalculator } from './gst-calculator.js';
import { defaultTaxRateCatalogue } from '../models/tax-catalogue.js';

export class NormalizerEngine {
  private policy: CalculationPolicy;

  constructor(policy: CalculationPolicy = DEFAULT_CALCULATION_POLICY) {
    this.policy = policy;
  }

  /**
   * Safely converts a raw string to Decimal without silently converting invalid strings to 0.
   * If value is required and missing, or invalid numeric, logs an issue and returns null.
   */
  public parseDecimalSafe(
    raw: string | undefined,
    fieldName: string,
    issues: ValidationIssue[],
    sourceRef: SourceReference,
    options: { required?: boolean; allowNegative?: boolean; defaultValueIfEmpty?: Decimal } = {}
  ): Decimal | null {
    const trimmed = raw ? raw.trim() : '';

    if (!trimmed) {
      if (options.required) {
        issues.push({
          code: IssueCode.MISSING_FIELD,
          severity: IssueSeverity.ERROR,
          field: fieldName,
          message: `Mandatory monetary field '${fieldName}' is empty or missing`,
          sourceRowNumber: sourceRef.sourceRowNumber,
          sourceReport: sourceRef.sourceReport
        });
        return null;
      }
      return options.defaultValueIfEmpty !== undefined ? options.defaultValueIfEmpty : new Decimal(0);
    }

    try {
      const dec = new Decimal(trimmed);
      if (!options.allowNegative && dec.isNegative()) {
        issues.push({
          code: IssueCode.NEGATIVE_TAXABLE_VALUE,
          severity: IssueSeverity.ERROR,
          field: fieldName,
          message: `Field '${fieldName}' has prohibited negative value: ${trimmed}`,
          sourceRowNumber: sourceRef.sourceRowNumber,
          sourceReport: sourceRef.sourceReport
        });
      }
      return dec;
    } catch {
      issues.push({
        code: IssueCode.INVALID_NUMERIC_VALUE,
        severity: IssueSeverity.ERROR,
        field: fieldName,
        message: `Field '${fieldName}' contains invalid numeric string: '${raw}'`,
        sourceRowNumber: sourceRef.sourceRowNumber,
        sourceReport: sourceRef.sourceReport
      });
      return null;
    }
  }

  /**
   * Normalizes any raw marketplace record into a strongly-typed NormalizedRecord.
   */
  public normalize(rawRecord: RawMarketplaceRecord): NormalizedRecord {
    const raw = rawRecord.rawFields;
    const sourceRef: SourceReference = {
      sourceReport: rawRecord.sourceReport,
      sourceRowNumber: rawRecord.sourceRowNumber,
      physicalLineNumber: rawRecord.physicalLineNumber,
      testCaseId: raw['Test Case ID'],
      expectedIssue: raw['Expected Issue'],
      rawRecord: raw
    };

    if (rawRecord.reportType === 'STOCK_TRANSFER') {
      return this.normalizeStockTransfer(raw, sourceRef);
    }

    if (rawRecord.reportType === 'CREDIT_NOTE') {
      return this.normalizeCreditNote(raw, sourceRef);
    }

    // Default outward supply (B2B, B2C, or Edge Cases)
    return this.normalizeOutwardSupply(raw, sourceRef);
  }

  private normalizeOutwardSupply(raw: Record<string, string>, sourceRef: SourceReference): NormalizedRecord {
    const issues: ValidationIssue[] = [];
    const invoiceNumber = raw['Invoice Number'] ? raw['Invoice Number'].trim() : '';
    if (!invoiceNumber) {
      issues.push({
        code: IssueCode.MISSING_INVOICE_NUMBER,
        severity: IssueSeverity.ERROR,
        field: 'Invoice Number',
        message: 'Invoice Number is missing',
        sourceRowNumber: sourceRef.sourceRowNumber,
        sourceReport: sourceRef.sourceReport
      });
    }

    // Date validation
    const invoiceDateStr = raw['Invoice Date'];
    const invoiceDate = parseISODateStrict(invoiceDateStr);
    if (!invoiceDate) {
      issues.push({
        code: IssueCode.INVALID_INVOICE_DATE,
        severity: IssueSeverity.ERROR,
        field: 'Invoice Date',
        message: `Invalid or unparseable invoice date: '${invoiceDateStr}'`,
        sourceRowNumber: sourceRef.sourceRowNumber,
        sourceReport: sourceRef.sourceReport
      });
    }

    // State codes validation
    const shipFromState = raw['Ship From State Code'] ? raw['Ship From State Code'].trim() : '';
    const posState = raw['Place of Supply State Code'] ? raw['Place of Supply State Code'].trim() : '';

    if (!isValidStateCode(shipFromState)) {
      issues.push({
        code: IssueCode.INVALID_STATE_CODE,
        severity: IssueSeverity.ERROR,
        field: 'Ship From State Code',
        message: `Invalid Ship From State Code: '${shipFromState}'`,
        sourceRowNumber: sourceRef.sourceRowNumber,
        sourceReport: sourceRef.sourceReport
      });
    }
    if (!isValidStateCode(posState)) {
      issues.push({
        code: IssueCode.INVALID_STATE_CODE,
        severity: IssueSeverity.ERROR,
        field: 'Place of Supply State Code',
        message: `Invalid Place of Supply State Code: '${posState}'`,
        sourceRowNumber: sourceRef.sourceRowNumber,
        sourceReport: sourceRef.sourceReport
      });
    }

    // HSN check (GST-008: warning if missing)
    const hsnSac = raw['HSN/SAC'] ? raw['HSN/SAC'].trim() : '';
    if (!hsnSac) {
      issues.push({
        code: IssueCode.MISSING_HSN,
        severity: IssueSeverity.WARNING,
        field: 'HSN/SAC',
        message: 'HSN/SAC code is missing',
        sourceRowNumber: sourceRef.sourceRowNumber,
        sourceReport: sourceRef.sourceReport
      });
    }

    // Mandatory monetary values (allowNegative: false flags GST-006)
    const taxableValue = this.parseDecimalSafe(raw['Taxable Value'], 'Taxable Value', issues, sourceRef, {
      required: true,
      allowNegative: false
    });
    const shippingTaxableValue = this.parseDecimalSafe(
      raw['Shipping Taxable Value'],
      'Shipping Taxable Value',
      issues,
      sourceRef,
      { required: false, allowNegative: false, defaultValueIfEmpty: new Decimal(0) }
    );
    const taxRate = this.parseDecimalSafe(raw['Tax Rate'], 'Tax Rate', issues, sourceRef, {
      required: true,
      allowNegative: false
    });

    const declaredCgst = this.parseDecimalSafe(raw['CGST Amount'], 'CGST Amount', issues, sourceRef, {
      required: false,
      defaultValueIfEmpty: new Decimal(0)
    });
    const declaredSgst = this.parseDecimalSafe(raw['SGST Amount'], 'SGST Amount', issues, sourceRef, {
      required: false,
      defaultValueIfEmpty: new Decimal(0)
    });
    const declaredIgst = this.parseDecimalSafe(raw['IGST Amount'], 'IGST Amount', issues, sourceRef, {
      required: false,
      defaultValueIfEmpty: new Decimal(0)
    });
    const declaredCess = this.parseDecimalSafe(raw['Compensatory Cess Amount'], 'Compensatory Cess Amount', issues, sourceRef, {
      required: false,
      defaultValueIfEmpty: new Decimal(0)
    });
    const declaredInvAmount = this.parseDecimalSafe(raw['Invoice Amount'], 'Invoice Amount', issues, sourceRef, {
      required: false
    });

    // If critical fields cannot be parsed to Decimal or date is missing, return MalformedRecord
    if (!invoiceDate || taxableValue === null || taxRate === null || !invoiceNumber) {
      return {
        recordType: 'MALFORMED',
        id: `malformed-${sourceRef.sourceReport}-${sourceRef.sourceRowNumber}`,
        sourceRef,
        rawFields: raw,
        errorSummary: issues.map((i) => i.message).join('; '),
        issues
      };
    }

    // Rate catalogue check (GST-015)
    if (!defaultTaxRateCatalogue.isRateValid(taxRate, raw['Invoice Date'])) {
      issues.push({
        code: IssueCode.INVALID_TAX_RATE,
        severity: IssueSeverity.ERROR,
        field: 'Tax Rate',
        message: `Tax rate ${taxRate.toString()}% is not in configured rate catalogue for date ${raw['Invoice Date']}`,
        sourceRowNumber: sourceRef.sourceRowNumber,
        sourceReport: sourceRef.sourceReport
      });
    }

    // Determine supply type
    const supplyType =
      shipFromState && posState
        ? shipFromState === posState
          ? SupplyType.INTRASTATE
          : SupplyType.INTERSTATE
        : SupplyType.UNKNOWN;

    // Check tax type consistency with Place of Supply (GST-009)
    if (supplyType === SupplyType.INTERSTATE) {
      if ((declaredCgst && declaredCgst.gt(0)) || (declaredSgst && declaredSgst.gt(0))) {
        issues.push({
          code: IssueCode.INTERSTATE_WITH_CGST_SGST,
          severity: IssueSeverity.ERROR,
          field: 'Place of Supply',
          message: `Interstate supply from ${shipFromState} to ${posState} carries CGST/SGST instead of IGST`,
          sourceRowNumber: sourceRef.sourceRowNumber,
          sourceReport: sourceRef.sourceReport
        });
      }
    } else if (supplyType === SupplyType.INTRASTATE) {
      if (declaredIgst && declaredIgst.gt(0)) {
        issues.push({
          code: IssueCode.INTRASTATE_WITH_IGST,
          severity: IssueSeverity.ERROR,
          field: 'Place of Supply',
          message: `Intrastate supply within ${shipFromState} carries IGST instead of CGST/SGST`,
          sourceRowNumber: sourceRef.sourceRowNumber,
          sourceReport: sourceRef.sourceReport
        });
      }
    }

    // Calculate expected tax and check for math mismatches (GST-007)
    const expectedTax = GSTCalculator.calculateTax(
      {
        taxableValue,
        shippingTaxableValue: shippingTaxableValue || new Decimal(0),
        taxRate,
        supplyType,
        shipFromStateCode: shipFromState,
        placeOfSupplyStateCode: posState,
        cessRate: new Decimal(0),
        cessSpecific: declaredCess || new Decimal(0)
      },
      this.policy
    );

    if (supplyType === SupplyType.INTERSTATE && declaredIgst) {
      if (!GSTCalculator.isWithinTolerance(declaredIgst, expectedTax.igstAmount, this.policy.roundingTolerance)) {
        issues.push({
          code: IssueCode.TAX_MISMATCH,
          severity: IssueSeverity.ERROR,
          field: 'IGST Amount',
          message: `Declared IGST (${declaredIgst.toFixed(2)}) differs from calculated (${expectedTax.igstAmount.toFixed(2)})`,
          sourceRowNumber: sourceRef.sourceRowNumber,
          sourceReport: sourceRef.sourceReport
        });
      }
    } else if (supplyType === SupplyType.INTRASTATE) {
      if (declaredCgst && !GSTCalculator.isWithinTolerance(declaredCgst, expectedTax.cgstAmount, this.policy.roundingTolerance)) {
        issues.push({
          code: IssueCode.TAX_MISMATCH,
          severity: IssueSeverity.ERROR,
          field: 'CGST Amount',
          message: `Declared CGST (${declaredCgst.toFixed(2)}) differs from calculated (${expectedTax.cgstAmount.toFixed(2)})`,
          sourceRowNumber: sourceRef.sourceRowNumber,
          sourceReport: sourceRef.sourceReport
        });
      }
      if (declaredSgst && !GSTCalculator.isWithinTolerance(declaredSgst, expectedTax.sgstAmount, this.policy.roundingTolerance)) {
        issues.push({
          code: IssueCode.TAX_MISMATCH,
          severity: IssueSeverity.ERROR,
          field: 'SGST Amount',
          message: `Declared SGST (${declaredSgst.toFixed(2)}) differs from calculated (${expectedTax.sgstAmount.toFixed(2)})`,
          sourceRowNumber: sourceRef.sourceRowNumber,
          sourceReport: sourceRef.sourceReport
        });
      }
    }

    // Check declared invoice amount
    if (declaredInvAmount) {
      if (!GSTCalculator.isWithinTolerance(declaredInvAmount, expectedTax.totalInvoiceAmount, this.policy.roundingTolerance)) {
        issues.push({
          code: IssueCode.INVOICE_AMOUNT_MISMATCH,
          severity: IssueSeverity.ERROR,
          field: 'Invoice Amount',
          message: `Declared invoice amount (${declaredInvAmount.toFixed(2)}) differs from total calculated (${expectedTax.totalInvoiceAmount.toFixed(2)})`,
          sourceRowNumber: sourceRef.sourceRowNumber,
          sourceReport: sourceRef.sourceReport
        });
      }
    }

    const recipientTypeStr = raw['Recipient Type'] ? raw['Recipient Type'].trim().toUpperCase() : '';
    const recipientType =
      recipientTypeStr === 'B2B' ? RecipientType.B2B : recipientTypeStr === 'B2C' ? RecipientType.B2C : RecipientType.UNKNOWN;

    const record: OutwardSupplyRecord = {
      recordType: 'OUTWARD_SUPPLY',
      id: `${sourceRef.sourceReport}-${invoiceNumber}-${raw['SKU'] || 'item'}-${sourceRef.sourceRowNumber}`,
      sourceRef,
      sellerGstin: raw['Seller GSTIN'] ? raw['Seller GSTIN'].trim().toUpperCase() : '',
      customerGstin: raw['Customer Bill To GSTIN'] ? raw['Customer Bill To GSTIN'].trim().toUpperCase() : undefined,
      invoiceNumber,
      invoiceDate,
      financialYear: getFinancialYear(invoiceDate),
      orderId: raw['Order ID'] ? raw['Order ID'].trim() : '',
      shipmentId: raw['Shipment ID'] ? raw['Shipment ID'].trim() : undefined,
      sku: raw['SKU'] ? raw['SKU'].trim() : undefined,
      asin: raw['ASIN'] ? raw['ASIN'].trim() : undefined,
      hsnSac: hsnSac || undefined,
      quantity: raw['Quantity'] ? parseInt(raw['Quantity'], 10) || 1 : 1,
      productCategory: raw['Product Category'] ? raw['Product Category'].trim() : undefined,
      shipFromStateCode: shipFromState,
      placeOfSupplyStateCode: posState,
      supplyType,
      recipientType,
      currency: raw['Currency'] ? raw['Currency'].trim() : 'INR',
      taxBreakdown: {
        taxableValue,
        shippingTaxableValue: shippingTaxableValue || new Decimal(0),
        totalTaxableValue: expectedTax.totalTaxableValue,
        taxRate,
        cgstRate: declaredCgst ? expectedTax.cgstRate : new Decimal(0),
        cgstAmount: declaredCgst || new Decimal(0),
        sgstRate: declaredSgst ? expectedTax.sgstRate : new Decimal(0),
        sgstAmount: declaredSgst || new Decimal(0),
        utgstRate: new Decimal(0),
        utgstAmount: new Decimal(0),
        igstRate: declaredIgst ? expectedTax.igstRate : new Decimal(0),
        igstAmount: declaredIgst || new Decimal(0),
        cessAmount: declaredCess || new Decimal(0),
        totalInvoiceAmount: declaredInvAmount || expectedTax.totalInvoiceAmount
      },
      issues
    };

    return record;
  }

  private normalizeCreditNote(raw: Record<string, string>, sourceRef: SourceReference): NormalizedRecord {
    const issues: ValidationIssue[] = [];
    const cnNumber = raw['Credit Note Number'] ? raw['Credit Note Number'].trim() : '';
    const cnDateStr = raw['Credit Note Date'];
    const cnDate = parseISODateStrict(cnDateStr);

    if (!cnDate || !cnNumber) {
      return {
        recordType: 'MALFORMED',
        id: `malformed-cn-${sourceRef.sourceRowNumber}`,
        sourceRef,
        rawFields: raw,
        errorSummary: `Invalid credit note date or number: ${cnDateStr}, ${cnNumber}`,
        issues
      };
    }

    const taxableReversal = this.parseDecimalSafe(raw['Taxable Value Reversal'], 'Taxable Value Reversal', issues, sourceRef, {
      required: true,
      allowNegative: false
    }) || new Decimal(0);
    const cgstReversal = this.parseDecimalSafe(raw['CGST Amount Reversal'], 'CGST Amount Reversal', issues, sourceRef, {
      defaultValueIfEmpty: new Decimal(0)
    }) || new Decimal(0);
    const sgstReversal = this.parseDecimalSafe(raw['SGST Amount Reversal'], 'SGST Amount Reversal', issues, sourceRef, {
      defaultValueIfEmpty: new Decimal(0)
    }) || new Decimal(0);
    const igstReversal = this.parseDecimalSafe(raw['IGST Amount Reversal'], 'IGST Amount Reversal', issues, sourceRef, {
      defaultValueIfEmpty: new Decimal(0)
    }) || new Decimal(0);
    const totalReversal = this.parseDecimalSafe(raw['Credit Note Total'], 'Credit Note Total', issues, sourceRef, {
      required: true
    }) || new Decimal(0);

    const origDate = parseISODateStrict(raw['Original Invoice Date']);

    const record: CreditNoteRecord = {
      recordType: 'CREDIT_NOTE',
      id: `${sourceRef.sourceReport}-${cnNumber}-${sourceRef.sourceRowNumber}`,
      sourceRef,
      creditNoteNumber: cnNumber,
      creditNoteDate: cnDate,
      originalInvoiceNumber: raw['Original Invoice Number'] ? raw['Original Invoice Number'].trim() : undefined,
      originalInvoiceDate: origDate || undefined,
      financialYear: getFinancialYear(cnDate),
      orderId: raw['Order ID'] ? raw['Order ID'].trim() : undefined,
      recipientType: raw['Recipient Type']?.toUpperCase() === 'B2B' ? RecipientType.B2B : RecipientType.B2C,
      sellerGstin: raw['Seller GSTIN'] ? raw['Seller GSTIN'].trim().toUpperCase() : '',
      customerGstin: raw['Customer Bill To GSTIN'] ? raw['Customer Bill To GSTIN'].trim().toUpperCase() : undefined,
      placeOfSupplyStateCode: raw['Place of Supply State Code'] ? raw['Place of Supply State Code'].trim() : undefined,
      hsnSac: raw['HSN/SAC'] ? raw['HSN/SAC'].trim() : undefined,
      taxableValueReversal: taxableReversal,
      cgstAmountReversal: cgstReversal,
      sgstAmountReversal: sgstReversal,
      utgstAmountReversal: new Decimal(0),
      igstAmountReversal: igstReversal,
      creditNoteTotal: totalReversal,
      reason: raw['Reason'] ? raw['Reason'].trim() : undefined,
      reconciliationStatus: ReconciliationStatus.UNMATCHED_ORPHAN,
      issues
    };

    return record;
  }

  private normalizeStockTransfer(raw: Record<string, string>, sourceRef: SourceReference): NormalizedRecord {
    const issues: ValidationIssue[] = [];
    const transferInv = raw['Transfer Invoice Number'] ? raw['Transfer Invoice Number'].trim() : '';
    const transferDateStr = raw['Transfer Date'];
    const transferDate = parseISODateStrict(transferDateStr);

    if (!transferDate || !transferInv) {
      return {
        recordType: 'MALFORMED',
        id: `malformed-st-${sourceRef.sourceRowNumber}`,
        sourceRef,
        rawFields: raw,
        errorSummary: `Invalid stock transfer date or number: ${transferDateStr}, ${transferInv}`,
        issues
      };
    }

    const srcGstin = raw['Source GSTIN'] ? raw['Source GSTIN'].trim().toUpperCase() : '';
    const destGstin = raw['Destination GSTIN'] ? raw['Destination GSTIN'].trim().toUpperCase() : '';
    const srcPan = srcGstin.length === 15 ? srcGstin.slice(2, 12) : '';
    const destPan = destGstin.length === 15 ? destGstin.slice(2, 12) : '';

    const taxableValue = this.parseDecimalSafe(raw['Taxable Value'], 'Taxable Value', issues, sourceRef, {
      required: true,
      allowNegative: false
    }) || new Decimal(0);
    const igstRate = this.parseDecimalSafe(raw['IGST Rate'], 'IGST Rate', issues, sourceRef, { defaultValueIfEmpty: new Decimal(0) }) || new Decimal(0);
    const igstAmount = this.parseDecimalSafe(raw['IGST Amount'], 'IGST Amount', issues, sourceRef, { defaultValueIfEmpty: new Decimal(0) }) || new Decimal(0);
    const cgstRate = this.parseDecimalSafe(raw['CGST Rate'], 'CGST Rate', issues, sourceRef, { defaultValueIfEmpty: new Decimal(0) }) || new Decimal(0);
    const cgstAmount = this.parseDecimalSafe(raw['CGST Amount'], 'CGST Amount', issues, sourceRef, { defaultValueIfEmpty: new Decimal(0) }) || new Decimal(0);
    const sgstRate = this.parseDecimalSafe(raw['SGST Rate'], 'SGST Rate', issues, sourceRef, { defaultValueIfEmpty: new Decimal(0) }) || new Decimal(0);
    const sgstAmount = this.parseDecimalSafe(raw['SGST Amount'], 'SGST Amount', issues, sourceRef, { defaultValueIfEmpty: new Decimal(0) }) || new Decimal(0);
    const invAmount = this.parseDecimalSafe(raw['Invoice Amount'], 'Invoice Amount', issues, sourceRef, { defaultValueIfEmpty: new Decimal(0) }) || new Decimal(0);

    const record: StockTransferRecord = {
      recordType: 'STOCK_TRANSFER',
      id: `${sourceRef.sourceReport}-${transferInv}-${sourceRef.sourceRowNumber}`,
      sourceRef,
      transferInvoiceNumber: transferInv,
      transferDate,
      financialYear: getFinancialYear(transferDate),
      sourceGstin: srcGstin,
      destinationGstin: destGstin,
      sourcePan: srcPan,
      destinationPan: destPan,
      classification: StockTransferClassification.REVIEW_REQUIRED,
      shipFromStateCode: raw['Ship From State Code'] ? raw['Ship From State Code'].trim() : '',
      shipToStateCode: raw['Ship To State Code'] ? raw['Ship To State Code'].trim() : '',
      hsnSac: raw['HSN/SAC'] ? raw['HSN/SAC'].trim() : undefined,
      quantity: raw['Quantity'] ? parseInt(raw['Quantity'], 10) || 1 : 1,
      taxBreakdown: {
        taxableValue,
        shippingTaxableValue: new Decimal(0),
        totalTaxableValue: taxableValue,
        taxRate: igstRate.gt(0) ? igstRate : cgstRate.add(sgstRate),
        cgstRate,
        cgstAmount,
        sgstRate,
        sgstAmount,
        utgstRate: new Decimal(0),
        utgstAmount: new Decimal(0),
        igstRate,
        igstAmount,
        cessAmount: new Decimal(0),
        totalInvoiceAmount: invAmount
      },
      issues
    };

    return record;
  }
}

export const defaultNormalizer = new NormalizerEngine();
