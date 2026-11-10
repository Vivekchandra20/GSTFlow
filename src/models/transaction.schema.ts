import { z } from 'zod';
import { Decimal } from '../utils/decimal.js';
import {
  RecipientType,
  SupplyType,
  TransactionType,
  IssueSeverity,
  IssueCode,
  StockTransferClassification,
  ReconciliationStatus
} from './enums.js';

export const DecimalSchema = z.instanceof(Decimal).or(
  z.union([z.string(), z.number()]).transform((val) => new Decimal(val))
);

export const SourceReferenceSchema = z.object({
  sourceReport: z.string(),
  sourceRowNumber: z.number().int().positive(),
  physicalLineNumber: z.number().int().positive().optional(),
  testCaseId: z.string().optional(),
  expectedIssue: z.string().optional(),
  rawRecord: z.record(z.string(), z.any()).optional()
});

export const ValidationIssueSchema = z.object({
  code: z.nativeEnum(IssueCode).or(z.string()),
  severity: z.nativeEnum(IssueSeverity),
  field: z.string().optional(),
  message: z.string(),
  sourceRowNumber: z.number().int().positive(),
  sourceReport: z.string(),
  documentId: z.string().optional(),
  suggestedAction: z.string().optional()
});

export const TaxBreakdownSchema = z.object({
  taxableValue: DecimalSchema,
  shippingTaxableValue: DecimalSchema,
  totalTaxableValue: DecimalSchema,
  taxRate: DecimalSchema,
  cgstRate: DecimalSchema,
  cgstAmount: DecimalSchema,
  sgstRate: DecimalSchema,
  sgstAmount: DecimalSchema,
  utgstRate: DecimalSchema,
  utgstAmount: DecimalSchema,
  igstRate: DecimalSchema,
  igstAmount: DecimalSchema,
  cessAmount: DecimalSchema,
  totalInvoiceAmount: DecimalSchema
});

// 1. Outward Supply Line Item (B2B or B2C Shipment)
export const OutwardSupplyRecordSchema = z.object({
  recordType: z.literal('OUTWARD_SUPPLY'),
  id: z.string(),
  sourceRef: SourceReferenceSchema,
  sellerGstin: z.string().trim().toUpperCase(),
  customerGstin: z.string().trim().toUpperCase().optional(),
  invoiceNumber: z.string().trim(),
  invoiceDate: z.date(),
  financialYear: z.string(), // e.g. '2026-2027'
  orderId: z.string().trim(),
  shipmentId: z.string().trim().optional(),
  sku: z.string().trim().optional(),
  asin: z.string().trim().optional(),
  hsnSac: z.string().trim().optional(),
  quantity: z.number().int(),
  productCategory: z.string().optional(),
  shipFromStateCode: z.string().length(2),
  placeOfSupplyStateCode: z.string().length(2),
  supplyType: z.nativeEnum(SupplyType),
  recipientType: z.nativeEnum(RecipientType),
  taxBreakdown: TaxBreakdownSchema,
  currency: z.string().default('INR'),
  issues: z.array(ValidationIssueSchema).default([])
});

// 2. Credit Note Record (Reversal of outward supply)
export const CreditNoteRecordSchema = z.object({
  recordType: z.literal('CREDIT_NOTE'),
  id: z.string(),
  sourceRef: SourceReferenceSchema,
  creditNoteNumber: z.string().trim(),
  creditNoteDate: z.date(),
  originalInvoiceNumber: z.string().trim().optional(),
  originalInvoiceDate: z.date().optional(),
  financialYear: z.string(), // Derived from credit note date
  orderId: z.string().trim().optional(),
  recipientType: z.nativeEnum(RecipientType),
  sellerGstin: z.string().trim().toUpperCase(),
  customerGstin: z.string().trim().toUpperCase().optional(),
  placeOfSupplyStateCode: z.string().length(2).optional(),
  hsnSac: z.string().trim().optional(),
  taxableValueReversal: DecimalSchema,
  cgstAmountReversal: DecimalSchema,
  sgstAmountReversal: DecimalSchema,
  utgstAmountReversal: DecimalSchema.default(new Decimal(0)),
  igstAmountReversal: DecimalSchema,
  creditNoteTotal: DecimalSchema,
  reason: z.string().optional(),
  reconciliationStatus: z.nativeEnum(ReconciliationStatus).default(ReconciliationStatus.UNMATCHED_ORPHAN),
  matchedInvoiceNumber: z.string().optional(),
  issues: z.array(ValidationIssueSchema).default([])
});

// 3. Stock Transfer Record (Branch-to-branch movement)
export const StockTransferRecordSchema = z.object({
  recordType: z.literal('STOCK_TRANSFER'),
  id: z.string(),
  sourceRef: SourceReferenceSchema,
  transferInvoiceNumber: z.string().trim(),
  transferDate: z.date(),
  financialYear: z.string(),
  sourceGstin: z.string().trim().toUpperCase(),
  destinationGstin: z.string().trim().toUpperCase(),
  sourcePan: z.string().length(10),
  destinationPan: z.string().length(10),
  classification: z.nativeEnum(StockTransferClassification),
  shipFromStateCode: z.string().length(2),
  shipToStateCode: z.string().length(2),
  hsnSac: z.string().trim().optional(),
  quantity: z.number().int(),
  taxBreakdown: TaxBreakdownSchema,
  issues: z.array(ValidationIssueSchema).default([])
});

// 4. Cancelled Order Record (Cancelled before invoice / non-taxable supply)
export const CancelledOrderRecordSchema = z.object({
  recordType: z.literal('CANCELLED_ORDER'),
  id: z.string(),
  sourceRef: SourceReferenceSchema,
  orderId: z.string().trim(),
  orderDate: z.date().optional(),
  cancellationDate: z.date().optional(),
  sellerGstin: z.string().trim().toUpperCase().optional(),
  customerGstin: z.string().trim().toUpperCase().optional(),
  reason: z.string().optional(),
  createsTaxLiability: z.literal(false).default(false),
  issues: z.array(ValidationIssueSchema).default([])
});

// 5. Malformed Record (Retains raw payload for auditability without failing pipeline)
export const MalformedRecordSchema = z.object({
  recordType: z.literal('MALFORMED'),
  id: z.string(),
  sourceRef: SourceReferenceSchema,
  rawFields: z.record(z.string(), z.any()),
  errorSummary: z.string(),
  issues: z.array(ValidationIssueSchema)
});

// Discriminated Union for all normalized records
export const NormalizedRecordSchema = z.discriminatedUnion('recordType', [
  OutwardSupplyRecordSchema,
  CreditNoteRecordSchema,
  StockTransferRecordSchema,
  CancelledOrderRecordSchema,
  MalformedRecordSchema
]);

export type SourceReference = z.infer<typeof SourceReferenceSchema>;
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;
export type TaxBreakdown = z.infer<typeof TaxBreakdownSchema>;
export type OutwardSupplyRecord = z.infer<typeof OutwardSupplyRecordSchema>;
export type CreditNoteRecord = z.infer<typeof CreditNoteRecordSchema>;
export type StockTransferRecord = z.infer<typeof StockTransferRecordSchema>;
export type CancelledOrderRecord = z.infer<typeof CancelledOrderRecordSchema>;
export type MalformedRecord = z.infer<typeof MalformedRecordSchema>;
export type NormalizedRecord = z.infer<typeof NormalizedRecordSchema>;
