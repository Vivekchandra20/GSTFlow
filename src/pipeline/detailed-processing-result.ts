import { Decimal } from '../utils/decimal.js';
import {
  OutwardSupplyRecord,
  CreditNoteRecord,
  StockTransferRecord,
  CancelledOrderRecord,
  MalformedRecord
} from '../models/transaction.schema.js';
import { ValidationReport } from '../engine/validator.js';
import { PrimaryOutcome } from '../repositories/types.js';
import { ProcessingReport } from './processing-report.js';
import { RecipientType, SupplyType } from '../models/enums.js';

export interface DetailedInvoiceLine {
  record: OutwardSupplyRecord;
  validationReport: ValidationReport;
  primaryOutcome: PrimaryOutcome;
  filePath: string;
}

export interface DetailedProcessedInvoice {
  invoiceKey: string;
  sellerGstin: string;
  financialYear: string;
  invoiceNumber: string;
  invoiceDate: Date;
  orderId: string;
  recipientType: RecipientType;
  customerGstin?: string;
  shipFromStateCode: string;
  placeOfSupplyStateCode: string;
  supplyType: SupplyType;
  currency: string;
  lines: DetailedInvoiceLine[];
  totalTaxableValue: Decimal;
  shippingTaxableValue: Decimal;
  cgstAmount: Decimal;
  sgstAmount: Decimal;
  utgstAmount: Decimal;
  igstAmount: Decimal;
  cessAmount: Decimal;
  totalInvoiceAmount: Decimal;
  primaryOutcome: PrimaryOutcome;
  filePath: string;
}

export interface DetailedProcessedCreditNote {
  record: CreditNoteRecord;
  validationReport: ValidationReport;
  primaryOutcome: PrimaryOutcome;
  filePath: string;
}

export interface DetailedProcessedStockTransfer {
  record: StockTransferRecord;
  validationReport: ValidationReport;
  primaryOutcome: PrimaryOutcome;
  filePath: string;
}

export interface DetailedCancelledOrder {
  record: CancelledOrderRecord;
  validationReport: ValidationReport;
  primaryOutcome: PrimaryOutcome;
  filePath: string;
}

export interface DetailedMalformedRecord {
  record: MalformedRecord;
  validationReport: ValidationReport;
  primaryOutcome: PrimaryOutcome;
  filePath: string;
}

export interface DetailedProcessingResult {
  report: ProcessingReport;
  invoices: Map<string, DetailedProcessedInvoice>;
  creditNotes: DetailedProcessedCreditNote[];
  stockTransfers: DetailedProcessedStockTransfer[];
  cancelledOrders: DetailedCancelledOrder[];
  malformedRecords: DetailedMalformedRecord[];
}
