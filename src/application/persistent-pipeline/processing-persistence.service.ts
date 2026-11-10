import crypto from 'node:crypto';
import path from 'node:path';
import { Decimal } from '../../utils/decimal.js';
import {
  TenantContext,
  ICanonicalDocumentRepository,
  IProcessingResultRepository,
  IReconciliationRepository,
  ITransactionManager,
  TransactionClient,
  CreateCanonicalInvoiceInput,
  CreateCanonicalCreditNoteInput,
  CreateCanonicalStockTransferInput,
  CreateInvoiceProcessingResultInput,
  CreateInvoiceLineInput,
  CreateCreditNoteProcessingResultInput,
  CreateStockTransferProcessingResultInput,
  PrimaryOutcome,
  ImportBatchEntity,
  CanonicalCreditNoteAlreadyReconciledError,
  InvoiceReversalCapacityExceededError,
  ExecutionCheckpoint
} from '../../repositories/types.js';
import { ReconciliationStatus } from '../../models/enums.js';
import {
  DetailedProcessingResult,
  DetailedProcessedInvoice,
  DetailedProcessedCreditNote,
  DetailedProcessedStockTransfer
} from '../../pipeline/detailed-processing-result.js';
import {
  ProcessingPersistenceResult
} from './persistent-pipeline.types.js';
import {
  PersistenceExecutionError
} from './persistent-pipeline.errors.js';
import { logger } from '../../utils/logger.js';

export interface SourceFileInfo {
  sourceFileId: string;
  lineMap: Map<number, string>;
}

export interface ProcessingPersistenceServiceOptions {
  canonicalDocRepo: ICanonicalDocumentRepository;
  processingResultRepo: IProcessingResultRepository;
  reconciliationRepo?: IReconciliationRepository;
  transactionManager?: ITransactionManager;
  defaultChunkSize?: number;
}

/**
 * Service responsible for persisting structured domain calculation outputs
 * (Canonical Documents, Processing Results, Invoice Lines, Reconciliations) into PostgreSQL
 * in bounded, tenant-isolated transactional chunks.
 */
export class ProcessingPersistenceService {
  private readonly canonicalDocRepo: ICanonicalDocumentRepository;
  private readonly processingResultRepo: IProcessingResultRepository;
  private readonly reconciliationRepo?: IReconciliationRepository;
  private readonly transactionManager?: ITransactionManager;
  private readonly defaultChunkSize: number;

  constructor(options: ProcessingPersistenceServiceOptions) {
    this.canonicalDocRepo = options.canonicalDocRepo;
    this.processingResultRepo = options.processingResultRepo;
    this.reconciliationRepo = options.reconciliationRepo;
    this.transactionManager = options.transactionManager;
    this.defaultChunkSize = Math.max(50, Math.min(1000, options.defaultChunkSize || 250));
  }

  /**
   * Persists all invoices, credit notes, and stock transfers from a detailed domain execution.
   */
  public async persistBatchResults(
    ctx: TenantContext,
    batch: ImportBatchEntity,
    detailed: DetailedProcessingResult,
    sourceFileMap: Map<string, SourceFileInfo>,
    options?: { chunkSize?: number; onCheckpoint?: (checkpoint: ExecutionCheckpoint) => Promise<void> }
  ): Promise<ProcessingPersistenceResult> {
    const startTime = Date.now();
    const chunkSize = options?.chunkSize || this.defaultChunkSize;

    let canonicalInvoicesCreated = 0;
    let canonicalCreditNotesCreated = 0;
    let canonicalTransfersCreated = 0;
    let invoicesPersisted = 0;
    let invoiceLinesPersisted = 0;
    let creditNotesPersisted = 0;
    let stockTransfersPersisted = 0;
    let conflictsDetected = 0;
    let reconciliationsCreated = 0;
    let reconciliationsSuperseded = 0;
    let cumulativeReversalsApplied = 0;

    // Track invoice results for credit note matching within this batch
    // Key: invoiceNumber -> invoiceResultId
    const invoiceResultMapByInvoiceNumber = new Map<string, string>();

    try {
      // ========================================================
      // STEP 1: PERSIST INVOICES & INVOICE LINES IN BOUNDED CHUNKS
      // ========================================================
      if (options?.onCheckpoint) {
        await options.onCheckpoint(ExecutionCheckpoint.CANONICAL_PERSISTENCE);
      }

      const invoiceList = Array.from(detailed.invoices.values());

      for (let i = 0; i < invoiceList.length; i += chunkSize) {
        const chunk = invoiceList.slice(i, i + chunkSize);

        await this.runChunkTransaction(ctx, async (tx) => {
          for (const inv of chunk) {
            // 1. Get or Create Canonical Invoice
            const canonicalInput: CreateCanonicalInvoiceInput = {
              sellerGstin: inv.sellerGstin,
              financialYear: inv.financialYear,
              invoiceNumber: inv.invoiceNumber,
              invoiceDate: inv.invoiceDate,
              orderId: inv.orderId,
              recipientType: inv.recipientType,
              customerGstin: inv.customerGstin || null,
              shipFromStateCode: inv.shipFromStateCode,
              placeOfSupplyStateCode: inv.placeOfSupplyStateCode,
              supplyType: inv.supplyType,
              currency: inv.currency || 'INR'
            };

            const canonicalRes = await this.canonicalDocRepo.getOrCreateCanonicalInvoice(
              ctx,
              canonicalInput,
              tx
            );

            if (canonicalRes.isNew) canonicalInvoicesCreated++;
            if (canonicalRes.hasConflict) conflictsDetected++;

            // 2. Check Idempotency: Skip if result already exists for this batch
            if (!canonicalRes.isNew) {
              const existingResult = await this.processingResultRepo.findInvoiceResultByBatchAndCanonicalId(
                ctx,
                batch.id,
                canonicalRes.invoice.id,
                tx
              );

              if (existingResult) {
                invoiceResultMapByInvoiceNumber.set(inv.invoiceNumber, existingResult.id);
                continue;
              }
            }

            // 3. Prepare Line Items with exact Source Record lineage
            const linesInput: CreateInvoiceLineInput[] = inv.lines.map((l, index) => {
              const fileInfo =
                sourceFileMap.get(l.filePath) ||
                sourceFileMap.get(path.basename(l.filePath)) ||
                sourceFileMap.get(path.resolve(l.filePath));

              const lineKey =
                l.record.sourceRef.physicalLineNumber ??
                l.record.sourceRef.sourceRowNumber;
              const sourceRecordId =
                (fileInfo && lineKey !== undefined
                  ? fileInfo.lineMap.get(lineKey)
                  : undefined) ||
                fileInfo?.lineMap.values().next().value ||
                crypto.randomUUID();

              return {
                lineNumber: index + 1,
                sourceRecordId,
                sku: l.record.sku || null,
                asin: l.record.asin || null,
                hsnSac: l.record.hsnSac || null,
                productCategory: l.record.productCategory || null,
                quantity: new Decimal(l.record.quantity),
                unitPrice:
                  l.record.quantity > 0
                    ? l.record.taxBreakdown.taxableValue.div(l.record.quantity)
                    : l.record.taxBreakdown.taxableValue,
                itemTaxableValue: l.record.taxBreakdown.taxableValue,
                shippingTaxableValue: l.record.taxBreakdown.shippingTaxableValue,
                giftWrapTaxableValue: new Decimal('0.00'),
                itemPromoDiscount: new Decimal('0.00'),
                taxRate: l.record.taxBreakdown.taxRate,
                cgstRate: l.record.taxBreakdown.cgstRate,
                cgstAmount: l.record.taxBreakdown.cgstAmount,
                sgstRate: l.record.taxBreakdown.sgstRate,
                sgstAmount: l.record.taxBreakdown.sgstAmount,
                utgstRate: l.record.taxBreakdown.utgstRate,
                utgstAmount: l.record.taxBreakdown.utgstAmount,
                igstRate: l.record.taxBreakdown.igstRate,
                igstAmount: l.record.taxBreakdown.igstAmount,
                cessAmount: l.record.taxBreakdown.cessAmount,
                totalLineAmount: l.record.taxBreakdown.totalInvoiceAmount,
                amazonMetadata: (l.record.sourceRef.rawRecord || null) as Record<string, unknown> | null
              };
            });

            const primarySourceRecordId =
              linesInput[0]?.sourceRecordId || crypto.randomUUID();

            // 4. Create Invoice Processing Result
            const finalOutcome = canonicalRes.hasConflict
              ? PrimaryOutcome.REVIEW
              : inv.primaryOutcome;

            const resultInput: CreateInvoiceProcessingResultInput = {
              importBatchId: batch.id,
              canonicalInvoiceId: canonicalRes.invoice.id,
              sourceRecordId: primarySourceRecordId,
              totalTaxableValue: inv.totalTaxableValue,
              shippingTaxableValue: inv.shippingTaxableValue,
              cgstAmount: inv.cgstAmount,
              sgstAmount: inv.sgstAmount,
              utgstAmount: inv.utgstAmount,
              igstAmount: inv.igstAmount,
              cessAmount: inv.cessAmount,
              totalInvoiceAmount: inv.totalInvoiceAmount,
              reportedTcsCgst: new Decimal('0.00'),
              reportedTcsSgst: new Decimal('0.00'),
              reportedTcsIgst: new Decimal('0.00'),
              calculatedTcsCgst: new Decimal('0.00'),
              calculatedTcsSgst: new Decimal('0.00'),
              calculatedTcsIgst: new Decimal('0.00'),
              primaryOutcome: finalOutcome,
              version: canonicalRes.isNew ? 1 : undefined,
              lines: linesInput
            };

            const createdResult = await this.processingResultRepo.createInvoiceResult(
              ctx,
              resultInput,
              tx
            );

            invoicesPersisted++;
            invoiceLinesPersisted += linesInput.length;
            invoiceResultMapByInvoiceNumber.set(inv.invoiceNumber, createdResult.id);
          }
        });
      }

      // ========================================================
      // STEP 2: PERSIST CREDIT NOTES IN BOUNDED CHUNKS
      // ========================================================
      if (options?.onCheckpoint) {
        await options.onCheckpoint(ExecutionCheckpoint.CREDIT_NOTE_RECONCILIATION);
      }
      for (let i = 0; i < detailed.creditNotes.length; i += chunkSize) {
        const chunk = detailed.creditNotes.slice(i, i + chunkSize);

        await this.runChunkTransaction(ctx, async (tx) => {
          for (const cnItem of chunk) {
            // 1. Get or Create Canonical Credit Note
            const canonicalInput: CreateCanonicalCreditNoteInput = {
              sellerGstin: cnItem.record.sellerGstin,
              financialYear: cnItem.record.financialYear,
              creditNoteNumber: cnItem.record.creditNoteNumber,
              creditNoteDate: cnItem.record.creditNoteDate,
              originalInvoiceNumber: cnItem.record.originalInvoiceNumber || null,
              originalInvoiceDate: cnItem.record.originalInvoiceDate || null,
              orderId: cnItem.record.orderId || null,
              recipientType: cnItem.record.recipientType,
              customerGstin: cnItem.record.customerGstin || null,
              placeOfSupplyStateCode: cnItem.record.placeOfSupplyStateCode || null
            };

            const canonicalRes = await this.canonicalDocRepo.getOrCreateCanonicalCreditNote(
              ctx,
              canonicalInput,
              tx
            );

            if (canonicalRes.isNew) canonicalCreditNotesCreated++;
            if (canonicalRes.hasConflict) conflictsDetected++;

            // 2. Check Idempotency
            if (!canonicalRes.isNew) {
              const existingResult = await this.processingResultRepo.findCreditNoteResultByBatchAndCanonicalId(
                ctx,
                batch.id,
                canonicalRes.creditNote.id,
                tx
              );

              if (existingResult) {
                continue;
              }
            }

            // 3. Resolve matched invoice processing result
            let matchedInvoiceResultId: string | null = null;
            let finalReconciliationStatus = cnItem.record.reconciliationStatus;
            const targetInvoiceNumber =
              cnItem.record.matchedInvoiceNumber || cnItem.record.originalInvoiceNumber;

            // Check if this canonical credit note was already reconciled in any prior batch
            let priorCanonicalRec: any = null;
            if (this.reconciliationRepo) {
              priorCanonicalRec = await this.reconciliationRepo.findPriorReconciliationForCanonicalCreditNote(
                ctx,
                canonicalRes.creditNote.id,
                tx
              );
            }

            if (priorCanonicalRec) {
              // Prior reconciliation already exists for this canonical credit note
              matchedInvoiceResultId = priorCanonicalRec.invoiceResultId;
              finalReconciliationStatus = priorCanonicalRec.reconciliationStatus;
            } else if (targetInvoiceNumber) {
              matchedInvoiceResultId =
                invoiceResultMapByInvoiceNumber.get(targetInvoiceNumber) || null;

              if (!matchedInvoiceResultId) {
                // If matched invoice was from a prior batch, find its canonical document
                const priorCanonical = await this.canonicalDocRepo.findCanonicalInvoice(
                  ctx,
                  cnItem.record.sellerGstin,
                  cnItem.record.financialYear,
                  targetInvoiceNumber,
                  tx
                );
                if (priorCanonical) {
                  const priorResults = await this.processingResultRepo.findInvoiceResultsByCanonicalInvoice(
                    ctx,
                    priorCanonical.id,
                    tx
                  );
                  if (priorResults.length > 0) {
                    const targetInvResult = priorResults[priorResults.length - 1];
                    matchedInvoiceResultId = targetInvResult.id;

                    // If domain marked UNMATCHED_ORPHAN because the invoice was not in the current in-memory run,
                    // evaluate cross-batch capacity against the prior invoice result!
                    if (
                      finalReconciliationStatus === ReconciliationStatus.UNMATCHED_ORPHAN ||
                      !finalReconciliationStatus
                    ) {
                      const remainingCapacity = targetInvResult.totalTaxableValue.minus(
                        targetInvResult.cumulativeTaxableReversed
                      );
                      if (cnItem.record.taxableValueReversal.lte(remainingCapacity)) {
                        finalReconciliationStatus = cnItem.record.taxableValueReversal.equals(
                          targetInvResult.totalTaxableValue
                        )
                          ? ReconciliationStatus.MATCHED_FULL
                          : ReconciliationStatus.MATCHED_PARTIAL;
                      } else {
                        finalReconciliationStatus = ReconciliationStatus.VALUE_EXCEEDED;
                      }
                    }
                  }
                }
              }
            }

            // 4. Resolve source record ID
            const fileInfo =
              sourceFileMap.get(cnItem.filePath) ||
              sourceFileMap.get(path.basename(cnItem.filePath)) ||
              sourceFileMap.get(path.resolve(cnItem.filePath));

            const lineKey =
              cnItem.record.sourceRef.physicalLineNumber ??
              cnItem.record.sourceRef.sourceRowNumber;
            const sourceRecordId =
              (fileInfo && lineKey !== undefined
                ? fileInfo.lineMap.get(lineKey)
                : undefined) ||
              fileInfo?.lineMap.values().next().value ||
              crypto.randomUUID();

            const finalOutcome = canonicalRes.hasConflict
              ? PrimaryOutcome.REVIEW
              : cnItem.primaryOutcome;

            // Preserve signed financial convention
            const signedAmount = cnItem.record.creditNoteTotal.isNegative()
              ? cnItem.record.creditNoteTotal
              : cnItem.record.creditNoteTotal.negated();

            const cnResultInput: CreateCreditNoteProcessingResultInput = {
              importBatchId: batch.id,
              canonicalCreditNoteId: canonicalRes.creditNote.id,
              sourceRecordId,
              matchedInvoiceResultId,
              taxableValueReversal: cnItem.record.taxableValueReversal,
              cgstAmountReversal: cnItem.record.cgstAmountReversal,
              sgstAmountReversal: cnItem.record.sgstAmountReversal,
              utgstAmountReversal: cnItem.record.utgstAmountReversal,
              igstAmountReversal: cnItem.record.igstAmountReversal,
              creditNoteTotal: cnItem.record.creditNoteTotal,
              rawSignedAmountText: signedAmount.toFixed(2),
              signedAmount,
              reconciliationStatus: finalReconciliationStatus,
              primaryOutcome: finalOutcome
            };

            const createdCnResult = await this.processingResultRepo.createCreditNoteResult(
              ctx,
              cnResultInput,
              tx
            );
            creditNotesPersisted++;

            // 5. Apply Financial Reconciliation if matched to an invoice result
            if (
              this.reconciliationRepo &&
              matchedInvoiceResultId &&
              (priorCanonicalRec ||
                finalReconciliationStatus === ReconciliationStatus.MATCHED_FULL ||
                finalReconciliationStatus === ReconciliationStatus.MATCHED_PARTIAL)
            ) {
              const existingRec = await this.reconciliationRepo.findReconciliationByCreditNoteResultId(
                ctx,
                createdCnResult.id,
                tx
              );

              if (!existingRec) {
                const recRes = await this.reconciliationRepo.createReconciliation(
                  ctx,
                  {
                    importBatchId: batch.id,
                    creditNoteResultId: createdCnResult.id,
                    invoiceResultId: matchedInvoiceResultId,
                    reconciliationStatus: finalReconciliationStatus,
                    taxableReversed: cnItem.record.taxableValueReversal,
                    cgstReversed: cnItem.record.cgstAmountReversal,
                    sgstReversed: cnItem.record.sgstAmountReversal,
                    utgstReversed: cnItem.record.utgstAmountReversal,
                    igstReversed: cnItem.record.igstAmountReversal,
                    totalReversed: cnItem.record.creditNoteTotal,
                    allowSupersession: batch.executionMode === 'REPROCESSING'
                  },
                  tx
                );

                if (recRes.isSuperseded) {
                  reconciliationsSuperseded++;
                } else {
                  reconciliationsCreated++;
                }
                if (recRes.appliedFinancialReversal) {
                  cumulativeReversalsApplied++;
                }
              }
            }
          }
        });
      }

      // ========================================================
      // STEP 3: PERSIST STOCK TRANSFERS IN BOUNDED CHUNKS
      // ========================================================
      for (let i = 0; i < detailed.stockTransfers.length; i += chunkSize) {
        const chunk = detailed.stockTransfers.slice(i, i + chunkSize);

        await this.runChunkTransaction(ctx, async (tx) => {
          for (const stItem of chunk) {
            // 1. Get or Create Canonical Stock Transfer
            const canonicalInput: CreateCanonicalStockTransferInput = {
              sourceGstin: stItem.record.sourceGstin,
              financialYear: stItem.record.financialYear,
              transferInvoiceNumber: stItem.record.transferInvoiceNumber,
              transferDate: stItem.record.transferDate,
              destinationGstin: stItem.record.destinationGstin,
              sourcePan: stItem.record.sourcePan,
              destinationPan: stItem.record.destinationPan,
              shipFromStateCode: stItem.record.shipFromStateCode,
              shipToStateCode: stItem.record.shipToStateCode
            };

            const canonicalRes = await this.canonicalDocRepo.getOrCreateCanonicalStockTransfer(
              ctx,
              canonicalInput,
              tx
            );

            if (canonicalRes.isNew) canonicalTransfersCreated++;
            if (canonicalRes.hasConflict) conflictsDetected++;

            // 2. Check Idempotency
            if (!canonicalRes.isNew) {
              const existingResult = await this.processingResultRepo.findStockTransferResultByBatchAndCanonicalId(
                ctx,
                batch.id,
                canonicalRes.transfer.id,
                tx
              );

              if (existingResult) {
                continue;
              }
            }

            // 3. Resolve source record ID
            const fileInfo =
              sourceFileMap.get(stItem.filePath) ||
              sourceFileMap.get(path.basename(stItem.filePath)) ||
              sourceFileMap.get(path.resolve(stItem.filePath));

            const lineKey =
              stItem.record.sourceRef.physicalLineNumber ??
              stItem.record.sourceRef.sourceRowNumber;
            const sourceRecordId =
              (fileInfo && lineKey !== undefined
                ? fileInfo.lineMap.get(lineKey)
                : undefined) ||
              fileInfo?.lineMap.values().next().value ||
              crypto.randomUUID();

            const finalOutcome = canonicalRes.hasConflict
              ? PrimaryOutcome.REVIEW
              : stItem.primaryOutcome;

            const stResultInput: CreateStockTransferProcessingResultInput = {
              importBatchId: batch.id,
              canonicalTransferId: canonicalRes.transfer.id,
              sourceRecordId,
              classification: stItem.record.classification,
              quantity: new Decimal(stItem.record.quantity),
              taxableValue: stItem.record.taxBreakdown.totalTaxableValue,
              cgstAmount: stItem.record.taxBreakdown.cgstAmount,
              sgstAmount: stItem.record.taxBreakdown.sgstAmount,
              utgstAmount: stItem.record.taxBreakdown.utgstAmount,
              igstAmount: stItem.record.taxBreakdown.igstAmount,
              cessAmount: stItem.record.taxBreakdown.cessAmount,
              totalInvoiceAmount: stItem.record.taxBreakdown.totalInvoiceAmount,
              primaryOutcome: finalOutcome
            };

            await this.processingResultRepo.createStockTransferResult(ctx, stResultInput, tx);
            stockTransfersPersisted++;
          }
        });
      }

      const durationMs = Date.now() - startTime;

      logger.info({
        event: 'PROCESSING_RESULTS_PERSISTED',
        organizationId: ctx.organizationId,
        batchId: batch.id,
        invoicesPersisted,
        invoiceLinesPersisted,
        creditNotesPersisted,
        stockTransfersPersisted,
        canonicalInvoicesCreated,
        canonicalCreditNotesCreated,
        canonicalTransfersCreated,
        conflictsDetected,
        reconciliationsCreated,
        reconciliationsSuperseded,
        cumulativeReversalsApplied,
        durationMs
      }, 'Successfully persisted canonical documents and processing results.');

      return {
        invoicesPersisted,
        invoiceLinesPersisted,
        creditNotesPersisted,
        stockTransfersPersisted,
        canonicalInvoicesCreated,
        canonicalCreditNotesCreated,
        canonicalTransfersCreated,
        conflictsDetected,
        reconciliationsCreated,
        reconciliationsSuperseded,
        cumulativeReversalsApplied,
        durationMs
      };
    } catch (error: any) {
      if (
        error instanceof CanonicalCreditNoteAlreadyReconciledError ||
        error instanceof InvoiceReversalCapacityExceededError
      ) {
        throw error;
      }

      throw new PersistenceExecutionError(
        `Failed to persist processing results for batch ${batch.id}: ${error.message}`,
        {
          cause: error,
          organizationId: ctx.organizationId,
          batchId: batch.id
        }
      );
    }
  }

  /**
   * Executes an operation within a typed tenant-local transaction if transactionManager is configured.
   */
  private async runChunkTransaction<T>(
    ctx: TenantContext,
    fn: (tx?: TransactionClient) => Promise<T>
  ): Promise<T> {
    if (this.transactionManager) {
      return this.transactionManager.runInTransaction(ctx, async (scope) => {
        return fn(scope.client as TransactionClient);
      });
    }
    return fn();
  }
}
