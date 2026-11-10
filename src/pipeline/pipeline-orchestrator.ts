import { AmazonSyntheticAdapter, defaultAmazonAdapter } from '../adapters/amazon/amazon-synthetic.adapter.js';
import { AmazonMtrLiveAdapter } from '../adapters/amazon/amazon-live.adapter.js';
import { NormalizerEngine, defaultNormalizer } from '../engine/normalizer.js';
import { RouterEngine, defaultRouter, RouteDestination } from '../engine/router.js';
import { DeduplicationEngine, defaultDeduplicator } from '../engine/deduplicator.js';
import { ReconciliationEngine, defaultReconciler } from '../engine/reconciler.js';
import { StockTransferProcessor, defaultStockTransferProcessor } from '../engine/stock-transfer.js';
import { ValidationEngine, defaultValidator, ValidationStatus } from '../engine/validator.js';
import {
  ProcessingReport,
  PrimaryOutcomeCounts,
  CreditNoteReconciliationSummary,
  IssueSeverityCounts
} from './processing-report.js';
import {
  CreditNoteRecord,
  NormalizedRecord,
  OutwardSupplyRecord,
  StockTransferRecord,
  CancelledOrderRecord,
  MalformedRecord
} from '../models/transaction.schema.js';
import { IssueSeverity, ReconciliationStatus, RecipientType } from '../models/enums.js';
import { PrimaryOutcome } from '../repositories/types.js';
import { Decimal } from '../utils/decimal.js';
import {
  DetailedProcessingResult,
  DetailedProcessedInvoice,
  DetailedProcessedCreditNote,
  DetailedProcessedStockTransfer,
  DetailedCancelledOrder,
  DetailedMalformedRecord
} from './detailed-processing-result.js';

function toPrimaryOutcome(status: ValidationStatus): PrimaryOutcome {
  switch (status) {
    case ValidationStatus.ERROR:
      return PrimaryOutcome.ERROR;
    case ValidationStatus.REVIEW:
      return PrimaryOutcome.REVIEW;
    case ValidationStatus.WARNING:
      return PrimaryOutcome.WARNING;
    case ValidationStatus.VALID:
    default:
      return PrimaryOutcome.VALID;
  }
}

function mergePrimaryOutcome(current: PrimaryOutcome, next: PrimaryOutcome): PrimaryOutcome {
  const rank: Record<PrimaryOutcome, number> = {
    [PrimaryOutcome.VALID]: 1,
    [PrimaryOutcome.WARNING]: 2,
    [PrimaryOutcome.REVIEW]: 3,
    [PrimaryOutcome.ERROR]: 4
  };
  return rank[next] > rank[current] ? next : current;
}

export interface PipelineOrchestratorOptions {
  adapter?: AmazonSyntheticAdapter;
  normalizer?: NormalizerEngine;
  router?: RouterEngine;
  deduplicator?: DeduplicationEngine;
  reconciler?: ReconciliationEngine;
  stockTransferProcessor?: StockTransferProcessor;
  validator?: ValidationEngine;
}

export class PipelineOrchestrator {
  private adapter: AmazonSyntheticAdapter;
  private normalizer: NormalizerEngine;
  private router: RouterEngine;
  private deduplicator: DeduplicationEngine;
  private reconciler: ReconciliationEngine;
  private stockTransferProcessor: StockTransferProcessor;
  private validator: ValidationEngine;

  constructor(options: PipelineOrchestratorOptions = {}) {
    this.adapter = options.adapter || defaultAmazonAdapter;
    this.normalizer = options.normalizer || defaultNormalizer;
    this.router = options.router || defaultRouter;
    this.deduplicator = options.deduplicator || defaultDeduplicator;
    this.reconciler = options.reconciler || defaultReconciler;
    this.stockTransferProcessor = options.stockTransferProcessor || defaultStockTransferProcessor;
    this.validator = options.validator || defaultValidator;
  }

  public reset(): void {
    this.deduplicator.reset();
    this.reconciler.getRepository().reset();
  }

  /**
   * Processes a multi-file batch in dependency-safe order and returns both
   * the summary report and the detailed structured domain records.
   */
  public async processBatchDetailed(filePaths: string[]): Promise<DetailedProcessingResult> {
    const startTime = Date.now();
    const startMemoryMB = Math.round(process.memoryUsage().heapUsed / (1024 * 1024));
    let peakMemoryMB = startMemoryMB;

    // Reset pipeline state for fresh deterministic run
    this.reset();

    const outcomes: PrimaryOutcomeCounts = { valid: 0, warning: 0, review: 0, error: 0, total: 0 };
    const issuesBySeverity: IssueSeverityCounts = { errors: 0, warnings: 0, reviews: 0, total: 0 };
    const reconciliationSummary: CreditNoteReconciliationSummary = {
      totalCreditNotes: 0,
      matchedFull: 0,
      matchedPartial: 0,
      unmatchedOrphan: 0,
      ambiguousMatches: 0,
      valueExceeded: 0,
      jurisdictionMismatch: 0,
      matchedB2B: 0,
      matchedB2C: 0
    };

    const invoices = new Map<string, DetailedProcessedInvoice>();
    const creditNotes: DetailedProcessedCreditNote[] = [];
    const stockTransfers: DetailedProcessedStockTransfer[] = [];
    const cancelledOrders: DetailedCancelledOrder[] = [];
    const malformedRecords: DetailedMalformedRecord[] = [];

    // Sort files to ensure outward supplies are ingested first
    const sortedFiles = this.sortFilesByIngestionOrder(filePaths);

    for (const filePath of sortedFiles) {
      for await (const rawRecord of this.adapter.streamRecords(filePath)) {
        outcomes.total++;

        // Track peak heap memory
        const currentMemoryMB = Math.round(process.memoryUsage().heapUsed / (1024 * 1024));
        if (currentMemoryMB > peakMemoryMB) {
          peakMemoryMB = currentMemoryMB;
        }

        // 1. Normalization
        let record: NormalizedRecord = this.normalizer.normalize(rawRecord);

        // 2. Outward Supply Path
        if (record.recordType === 'OUTWARD_SUPPLY') {
          // Deduplication
          record = this.deduplicator.processRecord(record);
          // Routing
          const routed = this.router.route(record);
          record = routed.record;
          // Register invoice in repository for credit note reconciliation
          this.reconciler.getRepository().registerInvoice(record as OutwardSupplyRecord);
        }

        // 3. Credit Note Path
        else if (record.recordType === 'CREDIT_NOTE') {
          const routed = this.router.route(record);
          record = routed.record;
          // Reconcile against registered invoices
          const reconciled = this.reconciler.reconcileCreditNote(record as CreditNoteRecord);
          record = reconciled;

          reconciliationSummary.totalCreditNotes++;
          if (reconciled.reconciliationStatus === ReconciliationStatus.MATCHED_FULL) {
            reconciliationSummary.matchedFull++;
          } else if (reconciled.reconciliationStatus === ReconciliationStatus.MATCHED_PARTIAL) {
            reconciliationSummary.matchedPartial++;
          } else if (reconciled.reconciliationStatus === ReconciliationStatus.UNMATCHED_ORPHAN) {
            reconciliationSummary.unmatchedOrphan++;
          } else if (reconciled.reconciliationStatus === ReconciliationStatus.AMBIGUOUS_MATCH) {
            reconciliationSummary.ambiguousMatches++;
          } else if (reconciled.reconciliationStatus === ReconciliationStatus.VALUE_EXCEEDED) {
            reconciliationSummary.valueExceeded++;
          } else if (reconciled.reconciliationStatus === ReconciliationStatus.JURISDICTION_MISMATCH) {
            reconciliationSummary.jurisdictionMismatch++;
          }

          if (reconciled.matchedInvoiceNumber) {
            if (reconciled.recipientType === RecipientType.B2B) {
              reconciliationSummary.matchedB2B++;
            } else {
              reconciliationSummary.matchedB2C++;
            }
          }
        }

        // 4. Stock Transfer Path
        else if (record.recordType === 'STOCK_TRANSFER') {
          const routed = this.router.route(record);
          record = routed.record;
          record = this.stockTransferProcessor.classifyTransfer(record as StockTransferRecord);
        }

        // 5. Cancelled Order Path
        else if (record.recordType === 'CANCELLED_ORDER') {
          const routed = this.router.route(record);
          record = routed.record;
        }

        // 6. Validation Engine Execution
        const validationReport = this.validator.validate(record);
        const recordOutcome = toPrimaryOutcome(validationReport.status);

        // 7. Strictly Partitioned Primary Outcome Accounting (Zero Data Loss)
        if (validationReport.status === ValidationStatus.ERROR) {
          outcomes.error++;
        } else if (validationReport.status === ValidationStatus.REVIEW) {
          outcomes.review++;
        } else if (validationReport.status === ValidationStatus.WARNING) {
          outcomes.warning++;
        } else {
          outcomes.valid++;
        }

        // Aggregate issue counts
        for (const issue of validationReport.issues) {
          issuesBySeverity.total++;
          if (issue.severity === IssueSeverity.ERROR) issuesBySeverity.errors++;
          else if (issue.severity === IssueSeverity.WARNING) issuesBySeverity.warnings++;
          else if (issue.severity === IssueSeverity.REVIEW) issuesBySeverity.reviews++;
        }

        // 8. Capture structured records for persistence
        if (record.recordType === 'OUTWARD_SUPPLY') {
          const outward = record as OutwardSupplyRecord;
          const key = `${outward.sellerGstin}#${outward.financialYear}#${outward.invoiceNumber}`;
          let existingInv = invoices.get(key);
          if (!existingInv) {
            existingInv = {
              invoiceKey: key,
              sellerGstin: outward.sellerGstin,
              financialYear: outward.financialYear,
              invoiceNumber: outward.invoiceNumber,
              invoiceDate: outward.invoiceDate,
              orderId: outward.orderId,
              recipientType: outward.recipientType,
              customerGstin: outward.customerGstin,
              shipFromStateCode: outward.shipFromStateCode,
              placeOfSupplyStateCode: outward.placeOfSupplyStateCode,
              supplyType: outward.supplyType,
              currency: outward.currency || 'INR',
              lines: [],
              totalTaxableValue: outward.taxBreakdown.taxableValue,
              shippingTaxableValue: outward.taxBreakdown.shippingTaxableValue,
              cgstAmount: outward.taxBreakdown.cgstAmount,
              sgstAmount: outward.taxBreakdown.sgstAmount,
              utgstAmount: outward.taxBreakdown.utgstAmount,
              igstAmount: outward.taxBreakdown.igstAmount,
              cessAmount: outward.taxBreakdown.cessAmount,
              totalInvoiceAmount: outward.taxBreakdown.totalInvoiceAmount,
              primaryOutcome: recordOutcome,
              filePath
            };
            invoices.set(key, existingInv);
          } else {
            existingInv.totalTaxableValue = existingInv.totalTaxableValue.add(outward.taxBreakdown.taxableValue);
            existingInv.shippingTaxableValue = existingInv.shippingTaxableValue.add(outward.taxBreakdown.shippingTaxableValue);
            existingInv.cgstAmount = existingInv.cgstAmount.add(outward.taxBreakdown.cgstAmount);
            existingInv.sgstAmount = existingInv.sgstAmount.add(outward.taxBreakdown.sgstAmount);
            existingInv.utgstAmount = existingInv.utgstAmount.add(outward.taxBreakdown.utgstAmount);
            existingInv.igstAmount = existingInv.igstAmount.add(outward.taxBreakdown.igstAmount);
            existingInv.cessAmount = existingInv.cessAmount.add(outward.taxBreakdown.cessAmount);
            existingInv.totalInvoiceAmount = existingInv.totalInvoiceAmount.add(outward.taxBreakdown.totalInvoiceAmount);
            existingInv.primaryOutcome = mergePrimaryOutcome(existingInv.primaryOutcome, recordOutcome);
          }
          existingInv.lines.push({
            record: outward,
            validationReport,
            primaryOutcome: recordOutcome,
            filePath
          });
        } else if (record.recordType === 'CREDIT_NOTE') {
          creditNotes.push({
            record: record as CreditNoteRecord,
            validationReport,
            primaryOutcome: recordOutcome,
            filePath
          });
        } else if (record.recordType === 'STOCK_TRANSFER') {
          stockTransfers.push({
            record: record as StockTransferRecord,
            validationReport,
            primaryOutcome: recordOutcome,
            filePath
          });
        } else if (record.recordType === 'CANCELLED_ORDER') {
          cancelledOrders.push({
            record: record as CancelledOrderRecord,
            validationReport,
            primaryOutcome: recordOutcome,
            filePath
          });
        } else if (record.recordType === 'MALFORMED') {
          malformedRecords.push({
            record: record as MalformedRecord,
            validationReport,
            primaryOutcome: recordOutcome,
            filePath
          });
        }
      }
    }

    const durationMs = Date.now() - startTime;
    const recordsPerSecond = durationMs > 0 ? Math.round((outcomes.total / (durationMs / 1000))) : outcomes.total;
    const zeroDataLossVerified = outcomes.valid + outcomes.warning + outcomes.review + outcomes.error === outcomes.total;

    const report: ProcessingReport = {
      timestamp: new Date().toISOString(),
      filesProcessed: sortedFiles,
      totalRecordsIngested: outcomes.total,
      outcomes,
      issuesBySeverity,
      reconciliationSummary,
      performance: {
        durationMs,
        recordsPerSecond,
        startMemoryHeapUsedMB: startMemoryMB,
        peakMemoryHeapUsedMB: peakMemoryMB
      },
      zeroDataLossVerified
    };

    return {
      report,
      invoices,
      creditNotes,
      stockTransfers,
      cancelledOrders,
      malformedRecords
    };
  }

  /**
   * Processes a multi-file batch in dependency-safe order:
   * 1. Outward supplies (B2B, B2C) to populate invoice repository.
   * 2. Credit notes to reconcile against populated invoices.
   * 3. Stock transfers to classify inter-branch supplies.
   * 4. Edge cases / invalid fixtures.
   */
  public async processBatch(filePaths: string[]): Promise<ProcessingReport> {
    const detailed = await this.processBatchDetailed(filePaths);
    return detailed.report;
  }

  /**
   * Processes a live Amazon MTR batch where Shipments, Refunds, and Cancellations
   * are interleaved in single CSV files. Preserves multi-pass invoice registration
   * and credit note reconciliation so refunds appearing before original invoices
   * reconcile deterministically.
   */
  public async processLiveBatchDetailed(
    filePaths: string[],
    liveAdapterFactory?: (filePath: string) => AmazonMtrLiveAdapter
  ): Promise<DetailedProcessingResult> {
    const startTime = Date.now();
    const startMemoryMB = Math.round(process.memoryUsage().heapUsed / (1024 * 1024));
    let peakMemoryMB = startMemoryMB;

    this.reset();

    const outcomes: PrimaryOutcomeCounts = { valid: 0, warning: 0, review: 0, error: 0, total: 0 };
    const issuesBySeverity: IssueSeverityCounts = { errors: 0, warnings: 0, reviews: 0, total: 0 };
    const reconciliationSummary: CreditNoteReconciliationSummary = {
      totalCreditNotes: 0,
      matchedFull: 0,
      matchedPartial: 0,
      unmatchedOrphan: 0,
      ambiguousMatches: 0,
      valueExceeded: 0,
      jurisdictionMismatch: 0,
      matchedB2B: 0,
      matchedB2C: 0
    };

    const outwardSupplies: Array<{ record: OutwardSupplyRecord; filePath: string }> = [];
    const creditNotes: Array<{ record: CreditNoteRecord; filePath: string }> = [];
    const stockTransfers: Array<{ record: StockTransferRecord; filePath: string }> = [];
    const otherRecords: Array<{ record: NormalizedRecord; filePath: string }> = [];

    // Pass 1: Streaming Ingestion & Category Partitioning
    for (const filePath of filePaths) {
      const adapter = liveAdapterFactory ? liveAdapterFactory(filePath) : new AmazonMtrLiveAdapter({ sourceReportName: filePath });
      for await (const record of adapter.streamRecords(filePath)) {
        outcomes.total++;

        const currentMemoryMB = Math.round(process.memoryUsage().heapUsed / (1024 * 1024));
        if (currentMemoryMB > peakMemoryMB) {
          peakMemoryMB = currentMemoryMB;
        }

        if (record.recordType === 'OUTWARD_SUPPLY') {
          outwardSupplies.push({ record: record as OutwardSupplyRecord, filePath });
        } else if (record.recordType === 'CREDIT_NOTE') {
          creditNotes.push({ record: record as CreditNoteRecord, filePath });
        } else if (record.recordType === 'STOCK_TRANSFER') {
          stockTransfers.push({ record: record as StockTransferRecord, filePath });
        } else {
          otherRecords.push({ record, filePath });
        }
      }
    }

    const invoices = new Map<string, DetailedProcessedInvoice>();
    const detailedCreditNotes: DetailedProcessedCreditNote[] = [];
    const detailedStockTransfers: DetailedProcessedStockTransfer[] = [];
    const cancelledOrders: DetailedCancelledOrder[] = [];
    const malformedRecords: DetailedMalformedRecord[] = [];

    // Pass 2: Outward Supply Registration
    for (const item of outwardSupplies) {
      let record = this.deduplicator.processRecord(item.record) as OutwardSupplyRecord;
      const routed = this.router.route(record);
      record = routed.record as OutwardSupplyRecord;
      this.reconciler.getRepository().registerInvoice(record);

      const validationReport = this.validator.validate(record);
      const recordOutcome = toPrimaryOutcome(validationReport.status);

      const key = `${record.sellerGstin}#${record.financialYear}#${record.invoiceNumber}`;
      let existingInv = invoices.get(key);
      if (!existingInv) {
        existingInv = {
          invoiceKey: key,
          sellerGstin: record.sellerGstin,
          financialYear: record.financialYear,
          invoiceNumber: record.invoiceNumber,
          invoiceDate: record.invoiceDate,
          orderId: record.orderId,
          recipientType: record.recipientType,
          customerGstin: record.customerGstin,
          shipFromStateCode: record.shipFromStateCode,
          placeOfSupplyStateCode: record.placeOfSupplyStateCode,
          supplyType: record.supplyType,
          currency: record.currency || 'INR',
          lines: [],
          totalTaxableValue: record.taxBreakdown.taxableValue,
          shippingTaxableValue: record.taxBreakdown.shippingTaxableValue,
          cgstAmount: record.taxBreakdown.cgstAmount,
          sgstAmount: record.taxBreakdown.sgstAmount,
          utgstAmount: record.taxBreakdown.utgstAmount,
          igstAmount: record.taxBreakdown.igstAmount,
          cessAmount: record.taxBreakdown.cessAmount,
          totalInvoiceAmount: record.taxBreakdown.totalInvoiceAmount,
          primaryOutcome: recordOutcome,
          filePath: item.filePath
        };
        invoices.set(key, existingInv);
      } else {
        existingInv.totalTaxableValue = existingInv.totalTaxableValue.add(record.taxBreakdown.taxableValue);
        existingInv.shippingTaxableValue = existingInv.shippingTaxableValue.add(record.taxBreakdown.shippingTaxableValue);
        existingInv.cgstAmount = existingInv.cgstAmount.add(record.taxBreakdown.cgstAmount);
        existingInv.sgstAmount = existingInv.sgstAmount.add(record.taxBreakdown.sgstAmount);
        existingInv.utgstAmount = existingInv.utgstAmount.add(record.taxBreakdown.utgstAmount);
        existingInv.igstAmount = existingInv.igstAmount.add(record.taxBreakdown.igstAmount);
        existingInv.cessAmount = existingInv.cessAmount.add(record.taxBreakdown.cessAmount);
        existingInv.totalInvoiceAmount = existingInv.totalInvoiceAmount.add(record.taxBreakdown.totalInvoiceAmount);
        existingInv.primaryOutcome = mergePrimaryOutcome(existingInv.primaryOutcome, recordOutcome);
      }
      existingInv.lines.push({
        record,
        validationReport,
        primaryOutcome: recordOutcome,
        filePath: item.filePath
      });

      if (validationReport.status === ValidationStatus.VALID) outcomes.valid++;
      else if (validationReport.status === ValidationStatus.WARNING) outcomes.warning++;
      else if (validationReport.status === ValidationStatus.REVIEW) outcomes.review++;
      else if (validationReport.status === ValidationStatus.ERROR) outcomes.error++;

      issuesBySeverity.errors += validationReport.errorsCount;
      issuesBySeverity.warnings += validationReport.warningsCount;
      issuesBySeverity.reviews += validationReport.reviewCount;
      issuesBySeverity.total += validationReport.issues.length;
    }

    // Pass 3: Credit Note Reconciliation
    for (const item of creditNotes) {
      const routed = this.router.route(item.record);
      let record = routed.record as CreditNoteRecord;
      const reconciled = this.reconciler.reconcileCreditNote(record);

      reconciliationSummary.totalCreditNotes++;
      if (reconciled.reconciliationStatus === ReconciliationStatus.MATCHED_FULL) {
        reconciliationSummary.matchedFull++;
      } else if (reconciled.reconciliationStatus === ReconciliationStatus.MATCHED_PARTIAL) {
        reconciliationSummary.matchedPartial++;
      } else if (reconciled.reconciliationStatus === ReconciliationStatus.UNMATCHED_ORPHAN) {
        reconciliationSummary.unmatchedOrphan++;
      } else if (reconciled.reconciliationStatus === ReconciliationStatus.AMBIGUOUS_MATCH) {
        reconciliationSummary.ambiguousMatches++;
      } else if (reconciled.reconciliationStatus === ReconciliationStatus.VALUE_EXCEEDED) {
        reconciliationSummary.valueExceeded++;
      } else if (reconciled.reconciliationStatus === ReconciliationStatus.JURISDICTION_MISMATCH) {
        reconciliationSummary.jurisdictionMismatch++;
      }

      if (reconciled.matchedInvoiceNumber) {
        if (reconciled.recipientType === RecipientType.B2B) {
          reconciliationSummary.matchedB2B++;
        } else {
          reconciliationSummary.matchedB2C++;
        }
      }

      const validationReport = this.validator.validate(reconciled);
      const recordOutcome = toPrimaryOutcome(validationReport.status);

      detailedCreditNotes.push({
        record: reconciled,
        validationReport,
        primaryOutcome: recordOutcome,
        filePath: item.filePath
      });

      if (validationReport.status === ValidationStatus.VALID) outcomes.valid++;
      else if (validationReport.status === ValidationStatus.WARNING) outcomes.warning++;
      else if (validationReport.status === ValidationStatus.REVIEW) outcomes.review++;
      else if (validationReport.status === ValidationStatus.ERROR) outcomes.error++;

      issuesBySeverity.errors += validationReport.errorsCount;
      issuesBySeverity.warnings += validationReport.warningsCount;
      issuesBySeverity.reviews += validationReport.reviewCount;
      issuesBySeverity.total += validationReport.issues.length;
    }

    // Pass 4: Stock Transfers & Other Records
    for (const item of stockTransfers) {
      const routed = this.router.route(item.record);
      let record = routed.record as StockTransferRecord;
      record = this.stockTransferProcessor.classifyTransfer(record) as StockTransferRecord;

      const validationReport = this.validator.validate(record);
      const recordOutcome = toPrimaryOutcome(validationReport.status);

      detailedStockTransfers.push({
        record,
        validationReport,
        primaryOutcome: recordOutcome,
        filePath: item.filePath
      });

      if (validationReport.status === ValidationStatus.VALID) outcomes.valid++;
      else if (validationReport.status === ValidationStatus.WARNING) outcomes.warning++;
      else if (validationReport.status === ValidationStatus.REVIEW) outcomes.review++;
      else if (validationReport.status === ValidationStatus.ERROR) outcomes.error++;

      issuesBySeverity.errors += validationReport.errorsCount;
      issuesBySeverity.warnings += validationReport.warningsCount;
      issuesBySeverity.reviews += validationReport.reviewCount;
      issuesBySeverity.total += validationReport.issues.length;
    }

    for (const item of otherRecords) {
      let record = item.record;
      if (record.recordType === 'CANCELLED_ORDER') {
        const routed = this.router.route(record);
        record = routed.record;
        const validationReport = this.validator.validate(record);
        cancelledOrders.push({
          record: record as CancelledOrderRecord,
          validationReport,
          primaryOutcome: toPrimaryOutcome(validationReport.status),
          filePath: item.filePath
        });
        if (validationReport.status === ValidationStatus.VALID) outcomes.valid++;
        else if (validationReport.status === ValidationStatus.WARNING) outcomes.warning++;
        else if (validationReport.status === ValidationStatus.REVIEW) outcomes.review++;
        else if (validationReport.status === ValidationStatus.ERROR) outcomes.error++;

        issuesBySeverity.errors += validationReport.errorsCount;
        issuesBySeverity.warnings += validationReport.warningsCount;
        issuesBySeverity.reviews += validationReport.reviewCount;
        issuesBySeverity.total += validationReport.issues.length;
      } else if (record.recordType === 'MALFORMED') {
        const validationReport = this.validator.validate(record);
        malformedRecords.push({
          record: record as MalformedRecord,
          validationReport,
          primaryOutcome: toPrimaryOutcome(validationReport.status),
          filePath: item.filePath
        });
        outcomes.error++;
        issuesBySeverity.errors += validationReport.errorsCount;
        issuesBySeverity.total += validationReport.issues.length;
      }
    }

    const durationMs = Date.now() - startTime;
    const recordsPerSecond = durationMs > 0 ? Math.round((outcomes.total / durationMs) * 1000) : outcomes.total;
    const zeroDataLossVerified = (outcomes.valid + outcomes.warning + outcomes.review + outcomes.error) === outcomes.total;

    const report: ProcessingReport = {
      timestamp: new Date().toISOString(),
      filesProcessed: filePaths,
      totalRecordsIngested: outcomes.total,
      outcomes,
      issuesBySeverity,
      reconciliationSummary,
      performance: {
        durationMs,
        recordsPerSecond,
        startMemoryHeapUsedMB: startMemoryMB,
        peakMemoryHeapUsedMB: peakMemoryMB
      },
      zeroDataLossVerified
    };

    return {
      report,
      invoices,
      creditNotes: detailedCreditNotes,
      stockTransfers: detailedStockTransfers,
      cancelledOrders,
      malformedRecords
    };
  }

  public async processLiveBatch(
    filePaths: string[],
    liveAdapterFactory?: (filePath: string) => AmazonMtrLiveAdapter
  ): Promise<ProcessingReport> {
    const detailed = await this.processLiveBatchDetailed(filePaths, liveAdapterFactory);
    return detailed.report;
  }

  private sortFilesByIngestionOrder(filePaths: string[]): string[] {
    const outward: string[] = [];
    const creditNotes: string[] = [];
    const stockTransfers: string[] = [];
    const edgeCases: string[] = [];
    const others: string[] = [];

    for (const p of filePaths) {
      const lower = p.toLowerCase();
      if (lower.includes('b2b') || lower.includes('b2c')) {
        outward.push(p);
      } else if (lower.includes('credit_notes') || lower.includes('credit notes')) {
        creditNotes.push(p);
      } else if (lower.includes('stock_transfer') || lower.includes('stock transfer')) {
        stockTransfers.push(p);
      } else if (lower.includes('invalid') || lower.includes('edge')) {
        edgeCases.push(p);
      } else {
        others.push(p);
      }
    }

    // Ingestion order: outward supplies first, then credit notes, then transfers, then edge cases/others
    return [...outward, ...creditNotes, ...stockTransfers, ...edgeCases, ...others];
  }
}

export const defaultOrchestrator = new PipelineOrchestrator();
