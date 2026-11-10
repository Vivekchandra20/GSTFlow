import {
  BatchStatus,
  FileBatchStatus,
  RecordType,
  PrimaryOutcome
} from '@prisma/client';
import type { Prisma } from '@prisma/client';
import {
  RecipientType,
  SupplyType,
  StockTransferClassification,
  ReconciliationStatus
} from '../models/enums.js';
import { Decimal } from '../utils/decimal.js';

export type SourcePlatform = 'AMAZON' | 'FLIPKART' | 'MEESHO' | 'CUSTOM';
export const SourcePlatform = {
  AMAZON: 'AMAZON',
  FLIPKART: 'FLIPKART',
  MEESHO: 'MEESHO',
  CUSTOM: 'CUSTOM'
} as const;

export {
  BatchStatus,
  FileBatchStatus,
  RecordType,
  PrimaryOutcome
};

export type {
  RecipientType,
  SupplyType,
  StockTransferClassification,
  ReconciliationStatus
};

// ==========================================
// TENANT CONTEXT & TRANSACTION ABSTRACTION
// ==========================================

export interface TenantContext {
  readonly organizationId: string;
}

/**
 * Type-safe transaction client abstraction for persistent repository operations.
 * Resolves to the underlying database transaction client while maintaining compile-time type safety.
 */
export type TransactionClient = Prisma.TransactionClient;

/**
 * High-level transaction scope abstraction for application-level multi-operation workflows.
 * Decouples application coordinators from direct ORM internals.
 */
export interface TransactionScope {
  readonly organizationId: string;
  readonly transactionId?: string;
  readonly client?: unknown;
}

/**
 * Transaction manager contract for coordinating multi-operation transactional workflows.
 */
export interface ITransactionManager {
  runInTransaction<T>(
    ctx: TenantContext,
    fn: (scope: TransactionScope) => Promise<T>,
    existingScope?: TransactionScope
  ): Promise<T>;
}

// ==========================================
// SOURCE FILE & SOURCE RECORD TYPES
// ==========================================

export interface CreateSourceFileInput {
  id?: string;
  fileName: string;
  fileFingerprint: string; // 64-char hex SHA-256
  fileSizeBytes: bigint | number;
  storageUri: string;
  reportPeriod?: string | null;
  sourceReportType: string;
  totalPhysicalLines?: number;
}

export interface SourceFileEntity {
  id: string;
  organizationId: string;
  fileName: string;
  fileFingerprint: string;
  fileSizeBytes: bigint;
  storageUri: string;
  reportPeriod: string | null;
  sourceReportType: string;
  totalPhysicalLines: number;
  uploadedAt: Date;
}

export interface CreateSourceRecordInput {
  id?: string;
  physicalLineNumber: number;
  logicalRecordNumber: number;
  recordType: RecordType;
  rawPayload: Record<string, unknown> | any;
}

export interface SourceRecordEntity {
  id: string;
  organizationId: string;
  sourceFileId: string;
  physicalLineNumber: number;
  logicalRecordNumber: number;
  recordType: RecordType;
  rawPayload: any;
  createdAt: Date;
}

export interface BulkInsertSourceRecordsResult {
  insertedCount: number;
  skippedCount: number;
  totalProvided: number;
}

// ==========================================
// IMPORT BATCH TYPES
// ==========================================

export interface CreateImportBatchInput {
  id?: string;
  batchNumber: string;
  engineVersion: string;
  rulesVersion: string;
  executionMode?: string; // defaults to 'STANDARD'
  reprocessReason?: string | null;
  parentBatchId?: string | null;
  configuration?: Record<string, unknown>;
  sourceFileIds?: string[];
  gstRegistrationId?: string | null;
  sourcePlatform?: SourcePlatform;
}

export interface ImportBatchEntity {
  id: string;
  organizationId: string;
  batchNumber: string;
  engineVersion: string;
  rulesVersion: string;
  status: BatchStatus;
  executionMode: string;
  reprocessReason: string | null;
  parentBatchId: string | null;
  startedAt: Date;
  completedAt: Date | null;
  totalRecordsProcessed: number;
  configuration: any;
  gstRegistrationId?: string | null;
  sourcePlatform?: SourcePlatform;
}

export interface BatchSourceFileEntity {
  id: string;
  organizationId: string;
  importBatchId: string;
  sourceFileId: string;
  fileStatus: FileBatchStatus;
  processedLines: number;
  errorSummary: string | null;
}

export interface ImportBatchWithFiles extends ImportBatchEntity {
  fileAssociations: (BatchSourceFileEntity & { sourceFile: SourceFileEntity })[];
  parentBatch?: ImportBatchEntity | null;
}

export interface CreateReprocessingBatchInput {
  newBatchNumber: string;
  parentBatchId: string;
  reprocessReason: string;
  rulesVersion?: string;
  engineVersion?: string;
  sourceFileIds: string[];
  configuration?: Record<string, unknown>;
}

export interface UpdateBatchStatusMetadata {
  completedAt?: Date;
  totalRecordsProcessed?: number;
}

// ==========================================
// DOCUMENT CONFLICT DETECTION TYPES
// ==========================================

export interface DocumentConflictDetail {
  field: string;
  conflictType: string;
  existingValue: any;
  incomingValue: any;
  message: string;
}

export interface CanonicalInvoiceResult {
  invoice: CanonicalInvoiceEntity;
  isNew: boolean;
  hasConflict: boolean;
  conflictDetails?: DocumentConflictDetail[];
}

export interface CanonicalCreditNoteResult {
  creditNote: CanonicalCreditNoteEntity;
  isNew: boolean;
  hasConflict: boolean;
  conflictDetails?: DocumentConflictDetail[];
}

export interface CanonicalStockTransferResult {
  transfer: CanonicalStockTransferEntity;
  isNew: boolean;
  hasConflict: boolean;
  conflictDetails?: DocumentConflictDetail[];
}

// ==========================================
// CANONICAL FINANCIAL DOCUMENT TYPES
// ==========================================

export interface CreateCanonicalInvoiceInput {
  id?: string;
  sellerGstin: string;
  financialYear: string;
  invoiceNumber: string;
  invoiceDate: Date;
  orderId: string;
  recipientType: RecipientType;
  customerGstin?: string | null;
  shipFromStateCode: string;
  placeOfSupplyStateCode: string;
  supplyType: SupplyType;
  currency?: string;
  hasLegalHold?: boolean;
  legalProceedingReference?: string | null;
}

export interface CanonicalInvoiceEntity {
  id: string;
  organizationId: string;
  sellerGstin: string;
  financialYear: string;
  invoiceNumber: string;
  invoiceDate: Date;
  orderId: string;
  recipientType: RecipientType;
  customerGstin: string | null;
  shipFromStateCode: string;
  placeOfSupplyStateCode: string;
  supplyType: SupplyType;
  currency: string;
  hasLegalHold: boolean;
  legalProceedingReference: string | null;
  createdAt: Date;
}

export interface CreateCanonicalCreditNoteInput {
  id?: string;
  sellerGstin: string;
  financialYear: string;
  creditNoteNumber: string;
  creditNoteDate: Date;
  originalInvoiceNumber?: string | null;
  originalInvoiceDate?: Date | null;
  orderId?: string | null;
  recipientType: RecipientType;
  customerGstin?: string | null;
  placeOfSupplyStateCode?: string | null;
  hasLegalHold?: boolean;
}

export interface CanonicalCreditNoteEntity {
  id: string;
  organizationId: string;
  sellerGstin: string;
  financialYear: string;
  creditNoteNumber: string;
  creditNoteDate: Date;
  originalInvoiceNumber: string | null;
  originalInvoiceDate: Date | null;
  orderId: string | null;
  recipientType: RecipientType;
  customerGstin: string | null;
  placeOfSupplyStateCode: string | null;
  hasLegalHold: boolean;
  createdAt: Date;
}

export interface CreateCanonicalStockTransferInput {
  id?: string;
  sourceGstin: string;
  financialYear: string;
  transferInvoiceNumber: string;
  transferDate: Date;
  destinationGstin: string;
  sourcePan: string;
  destinationPan: string;
  shipFromStateCode: string;
  shipToStateCode: string;
  hasLegalHold?: boolean;
}

export interface CanonicalStockTransferEntity {
  id: string;
  organizationId: string;
  sourceGstin: string;
  financialYear: string;
  transferInvoiceNumber: string;
  transferDate: Date;
  destinationGstin: string;
  sourcePan: string;
  destinationPan: string;
  shipFromStateCode: string;
  shipToStateCode: string;
  hasLegalHold: boolean;
  createdAt: Date;
}

// ==========================================
// PROCESSING RESULT & LINE ITEM TYPES
// ==========================================

export type NumericField = Decimal | string | number;

export interface CreateInvoiceLineInput {
  id?: string;
  lineNumber: number;
  sourceRecordId: string;
  sku?: string | null;
  asin?: string | null;
  hsnSac?: string | null;
  productCategory?: string | null;
  quantity: NumericField;
  unitPrice?: NumericField | null;
  itemTaxableValue: NumericField;
  shippingTaxableValue?: NumericField;
  giftWrapTaxableValue?: NumericField;
  itemPromoDiscount?: NumericField;
  taxRate: NumericField;
  cgstRate?: NumericField;
  cgstAmount?: NumericField;
  sgstRate?: NumericField;
  sgstAmount?: NumericField;
  utgstRate?: NumericField;
  utgstAmount?: NumericField;
  igstRate?: NumericField;
  igstAmount?: NumericField;
  cessAmount?: NumericField;
  totalLineAmount: NumericField;
  amazonMetadata?: Record<string, unknown> | null;
}

export interface InvoiceLineEntity {
  id: string;
  organizationId: string;
  invoiceResultId: string;
  sourceRecordId: string;
  lineNumber: number;
  sku: string | null;
  asin: string | null;
  hsnSac: string | null;
  productCategory: string | null;
  quantity: Decimal;
  unitPrice: Decimal | null;
  itemTaxableValue: Decimal;
  shippingTaxableValue: Decimal;
  giftWrapTaxableValue: Decimal;
  itemPromoDiscount: Decimal;
  taxRate: Decimal;
  cgstRate: Decimal;
  cgstAmount: Decimal;
  sgstRate: Decimal;
  sgstAmount: Decimal;
  utgstRate: Decimal;
  utgstAmount: Decimal;
  igstRate: Decimal;
  igstAmount: Decimal;
  cessAmount: Decimal;
  totalLineAmount: Decimal;
  amazonMetadata: any;
  createdAt: Date;
}

export interface CreateInvoiceProcessingResultInput {
  id?: string;
  importBatchId: string;
  canonicalInvoiceId: string;
  sourceRecordId: string;
  totalTaxableValue: NumericField;
  shippingTaxableValue?: NumericField;
  cgstAmount?: NumericField;
  sgstAmount?: NumericField;
  utgstAmount?: NumericField;
  igstAmount?: NumericField;
  cessAmount?: NumericField;
  totalInvoiceAmount: NumericField;
  reportedTcsCgst?: NumericField;
  reportedTcsSgst?: NumericField;
  reportedTcsIgst?: NumericField;
  calculatedTcsCgst?: NumericField;
  calculatedTcsSgst?: NumericField;
  calculatedTcsIgst?: NumericField;
  primaryOutcome: PrimaryOutcome;
  version?: number;
  lines: CreateInvoiceLineInput[];
}

export interface InvoiceProcessingResultEntity {
  id: string;
  organizationId: string;
  importBatchId: string;
  canonicalInvoiceId: string;
  sourceRecordId: string;
  totalTaxableValue: Decimal;
  shippingTaxableValue: Decimal;
  cgstAmount: Decimal;
  sgstAmount: Decimal;
  utgstAmount: Decimal;
  igstAmount: Decimal;
  cessAmount: Decimal;
  totalInvoiceAmount: Decimal;
  reportedTcsCgst: Decimal;
  reportedTcsSgst: Decimal;
  reportedTcsIgst: Decimal;
  calculatedTcsCgst: Decimal;
  calculatedTcsSgst: Decimal;
  calculatedTcsIgst: Decimal;
  cumulativeTaxableReversed: Decimal;
  cumulativeCgstReversed: Decimal;
  cumulativeSgstReversed: Decimal;
  cumulativeUtgstReversed: Decimal;
  cumulativeIgstReversed: Decimal;
  cumulativeTotalReversed: Decimal;
  reversalCount: number;
  primaryOutcome: PrimaryOutcome;
  version: number;
  createdAt: Date;
  lines: InvoiceLineEntity[];
}

export interface CreateCreditNoteProcessingResultInput {
  id?: string;
  importBatchId: string;
  canonicalCreditNoteId: string;
  sourceRecordId: string;
  matchedInvoiceResultId?: string | null;
  taxableValueReversal: NumericField;
  cgstAmountReversal?: NumericField;
  sgstAmountReversal?: NumericField;
  utgstAmountReversal?: NumericField;
  igstAmountReversal?: NumericField;
  creditNoteTotal: NumericField;
  rawSignedAmountText: string;
  signedAmount: NumericField;
  reconciliationStatus?: ReconciliationStatus;
  primaryOutcome: PrimaryOutcome;
}

export interface CreditNoteProcessingResultEntity {
  id: string;
  organizationId: string;
  importBatchId: string;
  canonicalCreditNoteId: string;
  sourceRecordId: string;
  matchedInvoiceResultId: string | null;
  taxableValueReversal: Decimal;
  cgstAmountReversal: Decimal;
  sgstAmountReversal: Decimal;
  utgstAmountReversal: Decimal;
  igstAmountReversal: Decimal;
  creditNoteTotal: Decimal;
  rawSignedAmountText: string;
  signedAmount: Decimal;
  reconciliationStatus: ReconciliationStatus;
  primaryOutcome: PrimaryOutcome;
  createdAt: Date;
}

export interface CreateStockTransferProcessingResultInput {
  id?: string;
  importBatchId: string;
  canonicalTransferId: string;
  sourceRecordId: string;
  classification: StockTransferClassification;
  quantity: NumericField;
  taxableValue: NumericField;
  cgstAmount?: NumericField;
  sgstAmount?: NumericField;
  utgstAmount?: NumericField;
  igstAmount?: NumericField;
  cessAmount?: NumericField;
  totalInvoiceAmount: NumericField;
  primaryOutcome: PrimaryOutcome;
}

export interface StockTransferProcessingResultEntity {
  id: string;
  organizationId: string;
  importBatchId: string;
  canonicalTransferId: string;
  sourceRecordId: string;
  classification: StockTransferClassification;
  quantity: Decimal;
  taxableValue: Decimal;
  cgstAmount: Decimal;
  sgstAmount: Decimal;
  utgstAmount: Decimal;
  igstAmount: Decimal;
  cessAmount: Decimal;
  totalInvoiceAmount: Decimal;
  primaryOutcome: PrimaryOutcome;
  createdAt: Date;
}

// ==========================================
// RECONCILIATION TYPES
// ==========================================

export interface CreateReconciliationInput {
  id?: string;
  importBatchId: string;
  creditNoteResultId: string;
  invoiceResultId: string;
  reconciliationStatus: ReconciliationStatus;
  taxableReversed: NumericField;
  cgstReversed?: NumericField;
  sgstReversed?: NumericField;
  utgstReversed?: NumericField;
  igstReversed?: NumericField;
  totalReversed: NumericField;
  allowSupersession?: boolean;
}

export interface ReconciliationEntity {
  id: string;
  organizationId: string;
  importBatchId: string;
  creditNoteResultId: string;
  invoiceResultId: string;
  reconciliationStatus: ReconciliationStatus;
  taxableReversed: Decimal;
  cgstReversed: Decimal;
  sgstReversed: Decimal;
  utgstReversed: Decimal;
  igstReversed: Decimal;
  totalReversed: Decimal;
  priorCumulativeTaxable: Decimal;
  postCumulativeTaxable: Decimal;
  appliedAt: Date;
}

export interface ReconciliationResultOutput {
  reconciliation: ReconciliationEntity;
  isSuperseded: boolean;
  appliedFinancialReversal: boolean;
  message?: string;
}

// ==========================================
// REPOSITORY INTERFACES
// ==========================================

export interface ISourceRecordRepository {
  createSourceFile(ctx: TenantContext, input: CreateSourceFileInput, tx?: TransactionClient): Promise<SourceFileEntity>;
  findSourceFileById(ctx: TenantContext, sourceFileId: string, tx?: TransactionClient): Promise<SourceFileEntity | null>;
  findSourceFileByFingerprint(ctx: TenantContext, fingerprint: string, tx?: TransactionClient): Promise<SourceFileEntity | null>;
  bulkInsertSourceRecords(
    ctx: TenantContext,
    sourceFileId: string,
    records: CreateSourceRecordInput[],
    tx?: TransactionClient
  ): Promise<BulkInsertSourceRecordsResult>;
  findRecordsBySourceFile(
    ctx: TenantContext,
    sourceFileId: string,
    options?: { limit?: number; offset?: number; recordType?: RecordType },
    tx?: TransactionClient
  ): Promise<SourceRecordEntity[]>;
  countRecordsBySourceFile(
    ctx: TenantContext,
    sourceFileId: string,
    recordType?: RecordType,
    tx?: TransactionClient
  ): Promise<number>;
  findRecordById(ctx: TenantContext, recordId: string, tx?: TransactionClient): Promise<SourceRecordEntity | null>;
  updateSourceFileTotalLines(
    ctx: TenantContext,
    sourceFileId: string,
    totalLines: number,
    tx?: TransactionClient
  ): Promise<SourceFileEntity>;
  findRecordLineMap(
    ctx: TenantContext,
    sourceFileId: string,
    tx?: TransactionClient
  ): Promise<Map<number, string>>;
}

export interface IImportBatchRepository {
  createBatch(ctx: TenantContext, input: CreateImportBatchInput, tx?: TransactionClient): Promise<ImportBatchEntity>;
  getBatchById(ctx: TenantContext, batchId: string, tx?: TransactionClient): Promise<ImportBatchWithFiles | null>;
  getBatchByNumber(ctx: TenantContext, batchNumber: string, tx?: TransactionClient): Promise<ImportBatchEntity | null>;
  updateBatchStatus(
    ctx: TenantContext,
    batchId: string,
    currentStatus: BatchStatus,
    newStatus: BatchStatus,
    metadata?: UpdateBatchStatusMetadata,
    tx?: TransactionClient
  ): Promise<ImportBatchEntity>;
  associateSourceFile(
    ctx: TenantContext,
    batchId: string,
    sourceFileId: string,
    initialStatus?: FileBatchStatus,
    tx?: TransactionClient
  ): Promise<BatchSourceFileEntity>;
  updateBatchSourceFileStatus(
    ctx: TenantContext,
    batchId: string,
    sourceFileId: string,
    fileStatus: FileBatchStatus,
    processedLines?: number,
    errorSummary?: string | null,
    tx?: TransactionClient
  ): Promise<BatchSourceFileEntity>;
  createReprocessingBatch(
    ctx: TenantContext,
    input: CreateReprocessingBatchInput,
    tx?: TransactionClient
  ): Promise<ImportBatchEntity>;
  listBatches(
    ctx: TenantContext,
    options?: { status?: BatchStatus; executionMode?: string; limit?: number; offset?: number },
    tx?: TransactionClient
  ): Promise<ImportBatchEntity[]>;
  findBatchSourceFilesBySourceFile(
    ctx: TenantContext,
    sourceFileId: string,
    tx?: TransactionClient
  ): Promise<BatchSourceFileEntity[]>;
}

export interface ICanonicalDocumentRepository {
  getOrCreateCanonicalInvoice(
    ctx: TenantContext,
    input: CreateCanonicalInvoiceInput,
    tx?: TransactionClient
  ): Promise<CanonicalInvoiceResult>;
  findCanonicalInvoice(
    ctx: TenantContext,
    sellerGstin: string,
    financialYear: string,
    invoiceNumber: string,
    tx?: TransactionClient
  ): Promise<CanonicalInvoiceEntity | null>;
  findCanonicalInvoiceById(ctx: TenantContext, id: string, tx?: TransactionClient): Promise<CanonicalInvoiceEntity | null>;

  getOrCreateCanonicalCreditNote(
    ctx: TenantContext,
    input: CreateCanonicalCreditNoteInput,
    tx?: TransactionClient
  ): Promise<CanonicalCreditNoteResult>;
  findCanonicalCreditNote(
    ctx: TenantContext,
    sellerGstin: string,
    financialYear: string,
    creditNoteNumber: string,
    tx?: TransactionClient
  ): Promise<CanonicalCreditNoteEntity | null>;
  findCanonicalCreditNoteById(
    ctx: TenantContext,
    id: string,
    tx?: TransactionClient
  ): Promise<CanonicalCreditNoteEntity | null>;

  getOrCreateCanonicalStockTransfer(
    ctx: TenantContext,
    input: CreateCanonicalStockTransferInput,
    tx?: TransactionClient
  ): Promise<CanonicalStockTransferResult>;
  findCanonicalStockTransfer(
    ctx: TenantContext,
    sourceGstin: string,
    financialYear: string,
    transferInvoiceNumber: string,
    tx?: TransactionClient
  ): Promise<CanonicalStockTransferEntity | null>;
  findCanonicalStockTransferById(
    ctx: TenantContext,
    id: string,
    tx?: TransactionClient
  ): Promise<CanonicalStockTransferEntity | null>;
}

export interface IProcessingResultRepository {
  createInvoiceResult(
    ctx: TenantContext,
    input: CreateInvoiceProcessingResultInput,
    tx?: TransactionClient
  ): Promise<InvoiceProcessingResultEntity>;
  findInvoiceResultByBatchAndCanonicalId(
    ctx: TenantContext,
    importBatchId: string,
    canonicalInvoiceId: string,
    tx?: TransactionClient
  ): Promise<InvoiceProcessingResultEntity | null>;
  findInvoiceResultById(
    ctx: TenantContext,
    id: string,
    tx?: TransactionClient
  ): Promise<InvoiceProcessingResultEntity | null>;
  findInvoiceResultsByCanonicalInvoice(
    ctx: TenantContext,
    canonicalInvoiceId: string,
    tx?: TransactionClient
  ): Promise<InvoiceProcessingResultEntity[]>;

  createCreditNoteResult(
    ctx: TenantContext,
    input: CreateCreditNoteProcessingResultInput,
    tx?: TransactionClient
  ): Promise<CreditNoteProcessingResultEntity>;
  findCreditNoteResultByBatchAndCanonicalId(
    ctx: TenantContext,
    importBatchId: string,
    canonicalCreditNoteId: string,
    tx?: TransactionClient
  ): Promise<CreditNoteProcessingResultEntity | null>;
  findCreditNoteResultById(
    ctx: TenantContext,
    id: string,
    tx?: TransactionClient
  ): Promise<CreditNoteProcessingResultEntity | null>;
  findCreditNoteResultsByCanonicalCreditNote(
    ctx: TenantContext,
    canonicalCreditNoteId: string,
    tx?: TransactionClient
  ): Promise<CreditNoteProcessingResultEntity[]>;

  createStockTransferResult(
    ctx: TenantContext,
    input: CreateStockTransferProcessingResultInput,
    tx?: TransactionClient
  ): Promise<StockTransferProcessingResultEntity>;
  findStockTransferResultByBatchAndCanonicalId(
    ctx: TenantContext,
    importBatchId: string,
    canonicalTransferId: string,
    tx?: TransactionClient
  ): Promise<StockTransferProcessingResultEntity | null>;
  findStockTransferResultById(
    ctx: TenantContext,
    id: string,
    tx?: TransactionClient
  ): Promise<StockTransferProcessingResultEntity | null>;
  findStockTransferResultsByCanonicalTransfer(
    ctx: TenantContext,
    canonicalTransferId: string,
    tx?: TransactionClient
  ): Promise<StockTransferProcessingResultEntity[]>;
}

export interface IReconciliationRepository {
  createReconciliation(
    ctx: TenantContext,
    input: CreateReconciliationInput,
    tx?: TransactionClient
  ): Promise<ReconciliationResultOutput>;
  findReconciliationByCreditNoteResultId(
    ctx: TenantContext,
    creditNoteResultId: string,
    tx?: TransactionClient
  ): Promise<ReconciliationEntity | null>;
  findReconciliationsByInvoiceResultId(
    ctx: TenantContext,
    invoiceResultId: string,
    tx?: TransactionClient
  ): Promise<ReconciliationEntity[]>;
  findPriorReconciliationForCanonicalCreditNote(
    ctx: TenantContext,
    canonicalCreditNoteId: string,
    tx?: TransactionClient
  ): Promise<ReconciliationEntity | null>;
}

// ==========================================
// DOMAIN REPOSITORY ERRORS
// ==========================================

export class TenantAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantAuthorizationError';
  }
}

export class DuplicateSourceFileError extends Error {
  constructor(
    public readonly organizationId: string,
    public readonly fileFingerprint: string,
    public readonly existingFileId?: string
  ) {
    super(
      `Source file with fingerprint '${fileFingerprint}' already exists in organization '${organizationId}'.`
    );
    this.name = 'DuplicateSourceFileError';
  }
}

export class SourceFileNotFoundError extends Error {
  constructor(public readonly sourceFileId: string, public readonly organizationId: string) {
    super(`Source file '${sourceFileId}' not found in organization '${organizationId}'.`);
    this.name = 'SourceFileNotFoundError';
  }
}

export class BatchNotFoundError extends Error {
  constructor(public readonly batchId: string, public readonly organizationId: string) {
    super(`Import batch '${batchId}' not found in organization '${organizationId}'.`);
    this.name = 'BatchNotFoundError';
  }
}

export class CanonicalDocumentNotFoundError extends Error {
  constructor(public readonly documentId: string, public readonly organizationId: string) {
    super(`Canonical document '${documentId}' not found in organization '${organizationId}'.`);
    this.name = 'CanonicalDocumentNotFoundError';
  }
}

export class DuplicateProcessingResultError extends Error {
  constructor(
    public readonly organizationId: string,
    public readonly importBatchId: string,
    public readonly canonicalDocumentId: string,
    message?: string
  ) {
    super(
      message ||
        `Processing result already exists for batch '${importBatchId}' and canonical document '${canonicalDocumentId}' in organization '${organizationId}'. Historical results are immutable; reprocessing requires a new batch.`
    );
    this.name = 'DuplicateProcessingResultError';
  }
}

export class CanonicalCreditNoteAlreadyReconciledError extends Error {
  constructor(
    public readonly organizationId: string,
    public readonly canonicalCreditNoteId: string,
    public readonly priorReconciliationId: string,
    public readonly priorImportBatchId: string
  ) {
    super(
      `Canonical credit note '${canonicalCreditNoteId}' in organization '${organizationId}' was already reconciled under batch '${priorImportBatchId}' (reconciliation '${priorReconciliationId}'). Secondary financial application is forbidden to protect cumulative invoice reversals.`
    );
    this.name = 'CanonicalCreditNoteAlreadyReconciledError';
  }
}

export class InvoiceReversalCapacityExceededError extends Error {
  constructor(
    public readonly organizationId: string,
    public readonly invoiceResultId: string,
    public readonly component: string,
    public readonly requestedValue: string,
    public readonly availableCapacity: string
  ) {
    super(
      `Reversal capacity exceeded for invoice result '${invoiceResultId}' on component '${component}' in organization '${organizationId}'. Requested: ${requestedValue}, Available capacity: ${availableCapacity}.`
    );
    this.name = 'InvoiceReversalCapacityExceededError';
  }
}

export class DocumentIdentityConflictError extends Error {
  constructor(
    public readonly organizationId: string,
    public readonly documentType: string,
    public readonly documentNumber: string,
    public readonly conflictDetails: DocumentConflictDetail[]
  ) {
    super(
      `Canonical ${documentType} '${documentNumber}' in organization '${organizationId}' has identity attribute conflicts: ${conflictDetails.map((c) => c.message).join('; ')}`
    );
    this.name = 'DocumentIdentityConflictError';
  }
}

export class IllegalBatchStatusTransitionError extends Error {
  constructor(
    public readonly batchId: string,
    public readonly fromStatus: BatchStatus,
    public readonly toStatus: BatchStatus,
    message?: string
  ) {
    super(
      message ||
        `Illegal status transition for batch '${batchId}': cannot transition from ${fromStatus} to ${toStatus}.`
    );
    this.name = 'IllegalBatchStatusTransitionError';
  }
}

export class DuplicateBatchAssociationError extends Error {
  constructor(public readonly batchId: string, public readonly sourceFileId: string) {
    super(`Source file '${sourceFileId}' is already associated with batch '${batchId}'.`);
    this.name = 'DuplicateBatchAssociationError';
  }
}

// ==========================================
// ASYNCHRONOUS JOB & OUTBOX TYPES (PHASE 4.1)
// ==========================================

export enum OutboxStatus {
  PENDING = 'PENDING',
  CLAIMED = 'CLAIMED',
  PUBLISHED = 'PUBLISHED',
  FAILED = 'FAILED'
}

export enum JobStatus {
  QUEUED = 'QUEUED',
  PROCESSING = 'PROCESSING',
  RETRYING = 'RETRYING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED'
}

export enum ExecutionCheckpoint {
  STAGING = 'STAGING',
  DOMAIN_PROCESSING = 'DOMAIN_PROCESSING',
  CANONICAL_PERSISTENCE = 'CANONICAL_PERSISTENCE',
  CREDIT_NOTE_RECONCILIATION = 'CREDIT_NOTE_RECONCILIATION',
  COMPLETED = 'COMPLETED'
}

export enum BatchExecutionMode {
  INGESTION = 'INGESTION',
  REPROCESSING = 'REPROCESSING'
}

export interface OutboxEventEntity {
  id: string;
  organizationId: string;
  eventType: string;
  payload: any;
  status: OutboxStatus;
  claimedBy: string | null;
  leaseExpiresAt: Date | null;
  publishedAt: Date | null;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProcessingJobEntity {
  id: string;
  organizationId: string;
  importBatchId: string;
  jobType: string;
  status: JobStatus;
  executionCheckpoint: ExecutionCheckpoint;
  attempts: number;
  maxAttempts: number;
  bullmqJobId: string | null;
  executionMode: BatchExecutionMode;
  startedAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  lastError: string | null;
  errorStack: string | null;
  metadata: any | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateOutboxEventInput {
  eventType: string;
  payload: Record<string, unknown>;
}

export interface CreateProcessingJobInput {
  importBatchId: string;
  jobType?: string;
  maxAttempts?: number;
  bullmqJobId?: string | null;
  executionMode?: BatchExecutionMode;
  metadata?: Record<string, unknown>;
}

export interface ClaimedOutboxEvent {
  id: string;
  organizationId: string;
  eventType: string;
  payload: any;
  attempts: number;
}

export interface AuthoritativeJobResolution {
  id: string;
  organizationId: string;
  importBatchId: string;
  jobType: string;
  status: string;
  executionCheckpoint: string;
  attempts: number;
  maxAttempts: number;
}

export interface IOutboxRepository {
  createOutboxEvent(ctx: TenantContext, input: CreateOutboxEventInput, tx?: TransactionClient): Promise<OutboxEventEntity>;
  claimEvents(claimedBy: string, batchSize: number, leaseSeconds: number): Promise<ClaimedOutboxEvent[]>;
  markPublished(eventId: string, claimedBy: string): Promise<boolean>;
  failEvent(eventId: string, claimedBy: string, error: string, maxAttempts?: number): Promise<boolean>;
  findById(ctx: TenantContext, eventId: string, tx?: TransactionClient): Promise<OutboxEventEntity | null>;
}

export interface IProcessingJobRepository {
  createJob(ctx: TenantContext, input: CreateProcessingJobInput, tx?: TransactionClient): Promise<ProcessingJobEntity>;
  resolveJobAuthoritative(jobId: string): Promise<AuthoritativeJobResolution | null>;
  updateJobStatus(
    ctx: TenantContext,
    jobId: string,
    status: JobStatus,
    updates?: Partial<Omit<ProcessingJobEntity, 'id' | 'organizationId' | 'importBatchId'>>,
    tx?: TransactionClient
  ): Promise<ProcessingJobEntity>;
  updateCheckpoint(
    ctx: TenantContext,
    jobId: string,
    checkpoint: ExecutionCheckpoint,
    tx?: TransactionClient
  ): Promise<ProcessingJobEntity>;
  findById(ctx: TenantContext, jobId: string, tx?: TransactionClient): Promise<ProcessingJobEntity | null>;
  findByBatchId(ctx: TenantContext, batchId: string, tx?: TransactionClient): Promise<ProcessingJobEntity[]>;
}
