import crypto from 'crypto';
import { Decimal } from '../../utils/decimal.js';
import {
  IReconciliationRepository,
  TenantContext,
  CreateReconciliationInput,
  ReconciliationEntity,
  ReconciliationResultOutput,
  IProcessingResultRepository,
  CanonicalCreditNoteAlreadyReconciledError,
  CanonicalDocumentNotFoundError,
  TenantAuthorizationError,
  InvoiceReversalCapacityExceededError
} from '../types.js';

export class InMemoryReconciliationRepository implements IReconciliationRepository {
  private reconciliationsById = new Map<string, ReconciliationEntity>();
  private reconciliationsByCnResultId = new Map<string, ReconciliationEntity>();
  private reconciliationsByCanonicalCnId = new Map<string, ReconciliationEntity>();

  constructor(private readonly processingResultRepo?: IProcessingResultRepository) {}

  public reset(): void {
    this.reconciliationsById.clear();
    this.reconciliationsByCnResultId.clear();
    this.reconciliationsByCanonicalCnId.clear();
  }

  private validateTenant(ctx: TenantContext): void {
    if (!ctx || !ctx.organizationId) {
      throw new TenantAuthorizationError('Tenant context is missing or invalid.');
    }
  }

  public async createReconciliation(
    ctx: TenantContext,
    input: CreateReconciliationInput
  ): Promise<ReconciliationResultOutput> {
    this.validateTenant(ctx);

    let canonicalCnId: string | null = null;
    let cnResult: any = null;
    let invResult: any = null;

    if (this.processingResultRepo) {
      cnResult = await this.processingResultRepo.findCreditNoteResultById(
        ctx,
        input.creditNoteResultId
      );
      if (!cnResult) {
        throw new CanonicalDocumentNotFoundError(
          input.creditNoteResultId,
          ctx.organizationId
        );
      }
      canonicalCnId = cnResult.canonicalCreditNoteId;

      invResult = await this.processingResultRepo.findInvoiceResultById(
        ctx,
        input.invoiceResultId
      );
      if (!invResult) {
        throw new CanonicalDocumentNotFoundError(
          input.invoiceResultId,
          ctx.organizationId
        );
      }
    }

    // Check if canonical credit note was already reconciled
    if (canonicalCnId) {
      const prior = this.reconciliationsByCanonicalCnId.get(
        `${ctx.organizationId}#${canonicalCnId}`
      );
      if (prior) {
        if (!input.allowSupersession) {
          throw new CanonicalCreditNoteAlreadyReconciledError(
            ctx.organizationId,
            canonicalCnId,
            prior.id,
            prior.importBatchId
          );
        }

        const newTaxable = new Decimal(input.taxableReversed);
        const priorTaxable = prior.taxableReversed;
        const deltaTaxable = newTaxable.minus(priorTaxable);

        const newTotal = new Decimal(input.totalReversed);
        const priorTotal = prior.totalReversed;
        const deltaTotal = newTotal.minus(priorTotal);

        const newCgst = new Decimal(input.cgstReversed || 0);
        const priorCgst = prior.cgstReversed || new Decimal(0);
        const deltaCgst = newCgst.minus(priorCgst);

        const newSgst = new Decimal(input.sgstReversed || 0);
        const priorSgst = prior.sgstReversed || new Decimal(0);
        const deltaSgst = newSgst.minus(priorSgst);

        const newUtgst = new Decimal(input.utgstReversed || 0);
        const priorUtgst = prior.utgstReversed || new Decimal(0);
        const deltaUtgst = newUtgst.minus(priorUtgst);

        const newIgst = new Decimal(input.igstReversed || 0);
        const priorIgst = prior.igstReversed || new Decimal(0);
        const deltaIgst = newIgst.minus(priorIgst);

        const hasFinancialDelta =
          !deltaTaxable.isZero() ||
          !deltaTotal.isZero() ||
          !deltaCgst.isZero() ||
          !deltaSgst.isZero() ||
          !deltaUtgst.isZero() ||
          !deltaIgst.isZero();

        if (!hasFinancialDelta) {
          if (cnResult) {
            cnResult.matchedInvoiceResultId = input.invoiceResultId;
            cnResult.reconciliationStatus = input.reconciliationStatus;
          }

          return {
            reconciliation: prior,
            isSuperseded: true,
            appliedFinancialReversal: false,
            message: `Canonical credit note was previously reconciled under batch '${prior.importBatchId}'. Superseded without duplicating financial reversal.`
          };
        }

        // Apply financial delta
        if (invResult) {
          const totalTaxable = invResult.totalTaxableValue;
          const totalCgst = invResult.cgstAmount || new Decimal(0);
          const totalSgst = invResult.sgstAmount || new Decimal(0);
          const totalUtgst = invResult.utgstAmount || new Decimal(0);
          const totalIgst = invResult.igstAmount || new Decimal(0);
          const totalInvoiceAmount = invResult.totalInvoiceAmount;

          const currentTaxable = invResult.cumulativeTaxableReversed;
          const currentCgst = invResult.cumulativeCgstReversed || new Decimal(0);
          const currentSgst = invResult.cumulativeSgstReversed || new Decimal(0);
          const currentUtgst = invResult.cumulativeUtgstReversed || new Decimal(0);
          const currentIgst = invResult.cumulativeIgstReversed || new Decimal(0);
          const currentTotal = invResult.cumulativeTotalReversed;

          const postTaxable = currentTaxable.plus(deltaTaxable);
          const postCgst = currentCgst.plus(deltaCgst);
          const postSgst = currentSgst.plus(deltaSgst);
          const postUtgst = currentUtgst.plus(deltaUtgst);
          const postIgst = currentIgst.plus(deltaIgst);
          const postTotal = currentTotal.plus(deltaTotal);

          if (postTaxable.gt(totalTaxable)) {
            throw new InvoiceReversalCapacityExceededError(
              ctx.organizationId,
              input.invoiceResultId,
              'taxableValue',
              postTaxable.toFixed(2),
              totalTaxable.toFixed(2)
            );
          }
          if (postCgst.gt(totalCgst)) {
            throw new InvoiceReversalCapacityExceededError(
              ctx.organizationId,
              input.invoiceResultId,
              'cgstAmount',
              postCgst.toFixed(2),
              totalCgst.toFixed(2)
            );
          }
          if (postSgst.gt(totalSgst)) {
            throw new InvoiceReversalCapacityExceededError(
              ctx.organizationId,
              input.invoiceResultId,
              'sgstAmount',
              postSgst.toFixed(2),
              totalSgst.toFixed(2)
            );
          }
          if (postUtgst.gt(totalUtgst)) {
            throw new InvoiceReversalCapacityExceededError(
              ctx.organizationId,
              input.invoiceResultId,
              'utgstAmount',
              postUtgst.toFixed(2),
              totalUtgst.toFixed(2)
            );
          }
          if (postIgst.gt(totalIgst)) {
            throw new InvoiceReversalCapacityExceededError(
              ctx.organizationId,
              input.invoiceResultId,
              'igstAmount',
              postIgst.toFixed(2),
              totalIgst.toFixed(2)
            );
          }
          if (postTotal.gt(totalInvoiceAmount)) {
            throw new InvoiceReversalCapacityExceededError(
              ctx.organizationId,
              input.invoiceResultId,
              'totalInvoiceAmount',
              postTotal.toFixed(2),
              totalInvoiceAmount.toFixed(2)
            );
          }

          invResult.cumulativeTaxableReversed = postTaxable;
          invResult.cumulativeCgstReversed = postCgst;
          invResult.cumulativeSgstReversed = postSgst;
          invResult.cumulativeUtgstReversed = postUtgst;
          invResult.cumulativeIgstReversed = postIgst;
          invResult.cumulativeTotalReversed = postTotal;
        }

        const currentTaxable = invResult ? invResult.cumulativeTaxableReversed.minus(deltaTaxable) : new Decimal(0);
        const postTaxable = currentTaxable.plus(deltaTaxable);

        const supersededEntity: ReconciliationEntity = {
          id: input.id || crypto.randomUUID(),
          organizationId: ctx.organizationId,
          importBatchId: input.importBatchId,
          creditNoteResultId: input.creditNoteResultId,
          invoiceResultId: input.invoiceResultId,
          reconciliationStatus: input.reconciliationStatus,
          taxableReversed: newTaxable,
          cgstReversed: newCgst,
          sgstReversed: newSgst,
          utgstReversed: newUtgst,
          igstReversed: newIgst,
          totalReversed: newTotal,
          priorCumulativeTaxable: currentTaxable,
          postCumulativeTaxable: postTaxable,
          appliedAt: new Date()
        };

        this.reconciliationsById.set(`${ctx.organizationId}#${supersededEntity.id}`, supersededEntity);
        this.reconciliationsByCnResultId.set(
          `${ctx.organizationId}#${supersededEntity.creditNoteResultId}`,
          supersededEntity
        );
        this.reconciliationsByCanonicalCnId.set(
          `${ctx.organizationId}#${canonicalCnId}`,
          supersededEntity
        );

        if (cnResult) {
          cnResult.matchedInvoiceResultId = input.invoiceResultId;
          cnResult.reconciliationStatus = input.reconciliationStatus;
        }

        return {
          reconciliation: supersededEntity,
          isSuperseded: true,
          appliedFinancialReversal: true,
          message: `Canonical credit note was previously reconciled under batch '${prior.importBatchId}'. Superseded with financial delta adjustment.`
        };
      }
    }

    const currentTaxable = invResult ? invResult.cumulativeTaxableReversed : new Decimal(0);
    const currentCgst = invResult ? (invResult.cumulativeCgstReversed || new Decimal(0)) : new Decimal(0);
    const currentSgst = invResult ? (invResult.cumulativeSgstReversed || new Decimal(0)) : new Decimal(0);
    const currentUtgst = invResult ? (invResult.cumulativeUtgstReversed || new Decimal(0)) : new Decimal(0);
    const currentIgst = invResult ? (invResult.cumulativeIgstReversed || new Decimal(0)) : new Decimal(0);
    const currentTotal = invResult ? invResult.cumulativeTotalReversed : new Decimal(0);

    const taxableToReverse = new Decimal(input.taxableReversed);
    const cgstToReverse = new Decimal(input.cgstReversed || 0);
    const sgstToReverse = new Decimal(input.sgstReversed || 0);
    const utgstToReverse = new Decimal(input.utgstReversed || 0);
    const igstToReverse = new Decimal(input.igstReversed || 0);
    const totalToReverse = new Decimal(input.totalReversed);

    const postTaxable = currentTaxable.plus(taxableToReverse);
    const postCgst = currentCgst.plus(cgstToReverse);
    const postSgst = currentSgst.plus(sgstToReverse);
    const postUtgst = currentUtgst.plus(utgstToReverse);
    const postIgst = currentIgst.plus(igstToReverse);
    const postTotal = currentTotal.plus(totalToReverse);

    if (invResult) {
      const totalTaxable = invResult.totalTaxableValue;
      const totalCgst = invResult.cgstAmount || new Decimal(0);
      const totalSgst = invResult.sgstAmount || new Decimal(0);
      const totalUtgst = invResult.utgstAmount || new Decimal(0);
      const totalIgst = invResult.igstAmount || new Decimal(0);
      const totalInvoiceAmount = invResult.totalInvoiceAmount;

      if (postTaxable.gt(totalTaxable)) {
        throw new InvoiceReversalCapacityExceededError(
          ctx.organizationId,
          input.invoiceResultId,
          'taxableValue',
          postTaxable.toFixed(2),
          totalTaxable.toFixed(2)
        );
      }
      if (postCgst.gt(totalCgst)) {
        throw new InvoiceReversalCapacityExceededError(
          ctx.organizationId,
          input.invoiceResultId,
          'cgstAmount',
          postCgst.toFixed(2),
          totalCgst.toFixed(2)
        );
      }
      if (postSgst.gt(totalSgst)) {
        throw new InvoiceReversalCapacityExceededError(
          ctx.organizationId,
          input.invoiceResultId,
          'sgstAmount',
          postSgst.toFixed(2),
          totalSgst.toFixed(2)
        );
      }
      if (postUtgst.gt(totalUtgst)) {
        throw new InvoiceReversalCapacityExceededError(
          ctx.organizationId,
          input.invoiceResultId,
          'utgstAmount',
          postUtgst.toFixed(2),
          totalUtgst.toFixed(2)
        );
      }
      if (postIgst.gt(totalIgst)) {
        throw new InvoiceReversalCapacityExceededError(
          ctx.organizationId,
          input.invoiceResultId,
          'igstAmount',
          postIgst.toFixed(2),
          totalIgst.toFixed(2)
        );
      }
      if (postTotal.gt(totalInvoiceAmount)) {
        throw new InvoiceReversalCapacityExceededError(
          ctx.organizationId,
          input.invoiceResultId,
          'totalInvoiceAmount',
          postTotal.toFixed(2),
          totalInvoiceAmount.toFixed(2)
        );
      }
    }

    const entity: ReconciliationEntity = {
      id: input.id || crypto.randomUUID(),
      organizationId: ctx.organizationId,
      importBatchId: input.importBatchId,
      creditNoteResultId: input.creditNoteResultId,
      invoiceResultId: input.invoiceResultId,
      reconciliationStatus: input.reconciliationStatus,
      taxableReversed: taxableToReverse,
      cgstReversed: cgstToReverse,
      sgstReversed: sgstToReverse,
      utgstReversed: utgstToReverse,
      igstReversed: igstToReverse,
      totalReversed: totalToReverse,
      priorCumulativeTaxable: currentTaxable,
      postCumulativeTaxable: postTaxable,
      appliedAt: new Date()
    };

    this.reconciliationsById.set(`${ctx.organizationId}#${entity.id}`, entity);
    this.reconciliationsByCnResultId.set(
      `${ctx.organizationId}#${entity.creditNoteResultId}`,
      entity
    );
    if (canonicalCnId) {
      this.reconciliationsByCanonicalCnId.set(
        `${ctx.organizationId}#${canonicalCnId}`,
        entity
      );
    }

    // Update in-memory invoice cumulative reversals
    if (invResult) {
      invResult.cumulativeTaxableReversed = postTaxable;
      invResult.cumulativeCgstReversed = postCgst;
      invResult.cumulativeSgstReversed = postSgst;
      invResult.cumulativeUtgstReversed = postUtgst;
      invResult.cumulativeIgstReversed = postIgst;
      invResult.cumulativeTotalReversed = postTotal;
      invResult.reversalCount += 1;
    }
    if (cnResult) {
      cnResult.matchedInvoiceResultId = input.invoiceResultId;
      cnResult.reconciliationStatus = input.reconciliationStatus;
    }

    return {
      reconciliation: entity,
      isSuperseded: false,
      appliedFinancialReversal: true
    };
  }

  public async findReconciliationByCreditNoteResultId(
    ctx: TenantContext,
    creditNoteResultId: string
  ): Promise<ReconciliationEntity | null> {
    this.validateTenant(ctx);
    return (
      this.reconciliationsByCnResultId.get(`${ctx.organizationId}#${creditNoteResultId}`) ||
      null
    );
  }

  public async findReconciliationsByInvoiceResultId(
    ctx: TenantContext,
    invoiceResultId: string
  ): Promise<ReconciliationEntity[]> {
    this.validateTenant(ctx);
    const list: ReconciliationEntity[] = [];
    for (const r of this.reconciliationsById.values()) {
      if (
        r.organizationId === ctx.organizationId &&
        r.invoiceResultId === invoiceResultId
      ) {
        list.push(r);
      }
    }
    list.sort((a, b) => a.appliedAt.getTime() - b.appliedAt.getTime());
    return list;
  }

  public async findPriorReconciliationForCanonicalCreditNote(
    ctx: TenantContext,
    canonicalCreditNoteId: string
  ): Promise<ReconciliationEntity | null> {
    this.validateTenant(ctx);
    return (
      this.reconciliationsByCanonicalCnId.get(
        `${ctx.organizationId}#${canonicalCreditNoteId}`
      ) || null
    );
  }
}
