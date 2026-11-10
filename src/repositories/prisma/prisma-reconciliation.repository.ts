import crypto from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { Decimal } from '../../utils/decimal.js';
import {
  IReconciliationRepository,
  TenantContext,
  CreateReconciliationInput,
  ReconciliationEntity,
  ReconciliationResultOutput,
  NumericField,
  CanonicalCreditNoteAlreadyReconciledError,
  CanonicalDocumentNotFoundError,
  InvoiceReversalCapacityExceededError
} from '../types.js';
import { runInTenantTransaction } from './tenant-context.js';

function toDec2(v: NumericField | undefined | null): string {
  if (v === undefined || v === null) return '0.00';
  return new Decimal(v).toFixed(2);
}

function fromDec(v: any): Decimal {
  return new Decimal(v ? v.toString() : '0');
}

export class PrismaReconciliationRepository implements IReconciliationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public async createReconciliation(
    ctx: TenantContext,
    input: CreateReconciliationInput,
    tx?: Prisma.TransactionClient
  ): Promise<ReconciliationResultOutput> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        // 1. Fetch credit note result and its canonical document
        const cnResult = await client.creditNoteProcessingResult.findFirst({
          where: { id: input.creditNoteResultId, organizationId: ctx.organizationId },
          include: { canonicalCreditNote: true }
        });
        if (!cnResult) {
          throw new CanonicalDocumentNotFoundError(
            input.creditNoteResultId,
            ctx.organizationId
          );
        }

        // 2. Fetch invoice result
        const invoiceResult = await client.invoiceProcessingResult.findFirst({
          where: { id: input.invoiceResultId, organizationId: ctx.organizationId }
        });
        if (!invoiceResult) {
          throw new CanonicalDocumentNotFoundError(
            input.invoiceResultId,
            ctx.organizationId
          );
        }

        // 3. Acquire row lock on Canonical Credit Note to serialize concurrent reconciliations
        await client.$queryRaw`
          SELECT id FROM canonical_credit_notes
          WHERE id = ${cnResult.canonicalCreditNoteId}::uuid AND organization_id = ${ctx.organizationId}::uuid
          FOR UPDATE;
        `;

        // 4. Check if this CanonicalCreditNote was ALREADY reconciled in ANY prior batch (under row lock)
        const priorReconciliation = await client.reconciliation.findFirst({
          where: {
            organizationId: ctx.organizationId,
            creditNoteResult: {
              canonicalCreditNoteId: cnResult.canonicalCreditNoteId
            }
          },
          orderBy: { appliedAt: 'desc' },
          include: {
            creditNoteResult: true
          }
        });

        if (priorReconciliation) {
          // If supersession is not explicitly permitted, reject to prevent duplicate reversal
          if (!input.allowSupersession) {
            throw new CanonicalCreditNoteAlreadyReconciledError(
              ctx.organizationId,
              cnResult.canonicalCreditNoteId,
              priorReconciliation.id,
              priorReconciliation.importBatchId
            );
          }

          // Calculate financial deltas between new credit note values and prior reconciliation values
          const newTaxable = fromDec(input.taxableReversed);
          const priorTaxable = fromDec(priorReconciliation.taxableReversed);
          const deltaTaxable = newTaxable.minus(priorTaxable);

          const newTotal = fromDec(input.totalReversed);
          const priorTotal = fromDec(priorReconciliation.totalReversed);
          const deltaTotal = newTotal.minus(priorTotal);

          const newCgst = fromDec(input.cgstReversed);
          const priorCgst = fromDec(priorReconciliation.cgstReversed);
          const deltaCgst = newCgst.minus(priorCgst);

          const newSgst = fromDec(input.sgstReversed);
          const priorSgst = fromDec(priorReconciliation.sgstReversed);
          const deltaSgst = newSgst.minus(priorSgst);

          const newUtgst = fromDec(input.utgstReversed);
          const priorUtgst = fromDec(priorReconciliation.utgstReversed);
          const deltaUtgst = newUtgst.minus(priorUtgst);

          const newIgst = fromDec(input.igstReversed);
          const priorIgst = fromDec(priorReconciliation.igstReversed);
          const deltaIgst = newIgst.minus(priorIgst);

          const hasFinancialDelta =
            !deltaTaxable.isZero() ||
            !deltaTotal.isZero() ||
            !deltaCgst.isZero() ||
            !deltaSgst.isZero() ||
            !deltaUtgst.isZero() ||
            !deltaIgst.isZero();

          if (!hasFinancialDelta) {
            // Supersession with zero delta: acknowledge prior reconciliation, update credit note status,
            // DO NOT create a second financial application or modify invoice cumulative totals!
            await client.creditNoteProcessingResult.update({
              where: { id: input.creditNoteResultId },
              data: {
                matchedInvoiceResultId: input.invoiceResultId,
                reconciliationStatus: input.reconciliationStatus
              }
            });

            return {
              reconciliation: this.mapReconciliation(priorReconciliation),
              isSuperseded: true,
              appliedFinancialReversal: false,
              message: `Canonical credit note was previously reconciled under batch '${priorReconciliation.importBatchId}'. Superseded without duplicating financial reversal.`
            };
          }

          // Supersession with financial delta: apply delta adjustment under invoice row lock
          const lockedInvoices: any[] = await client.$queryRaw`
            SELECT id, total_taxable_value, cgst_amount, sgst_amount, utgst_amount, igst_amount, total_invoice_amount,
                   cumulative_taxable_reversed, cumulative_cgst_reversed, cumulative_sgst_reversed,
                   cumulative_utgst_reversed, cumulative_igst_reversed, cumulative_total_reversed, reversal_count
            FROM invoice_processing_results
            WHERE id = ${input.invoiceResultId}::uuid AND organization_id = ${ctx.organizationId}::uuid
            FOR UPDATE;
          `;

          if (!lockedInvoices || lockedInvoices.length === 0) {
            throw new CanonicalDocumentNotFoundError(
              input.invoiceResultId,
              ctx.organizationId
            );
          }

          const invRow = lockedInvoices[0];
          const totalTaxable = fromDec(invRow.total_taxable_value);
          const totalCgst = fromDec(invRow.cgst_amount);
          const totalSgst = fromDec(invRow.sgst_amount);
          const totalUtgst = fromDec(invRow.utgst_amount);
          const totalIgst = fromDec(invRow.igst_amount);
          const totalInvoiceAmount = fromDec(invRow.total_invoice_amount);

          const currentTaxable = fromDec(invRow.cumulative_taxable_reversed);
          const currentCgst = fromDec(invRow.cumulative_cgst_reversed);
          const currentSgst = fromDec(invRow.cumulative_sgst_reversed);
          const currentUtgst = fromDec(invRow.cumulative_utgst_reversed);
          const currentIgst = fromDec(invRow.cumulative_igst_reversed);
          const currentTotal = fromDec(invRow.cumulative_total_reversed);

          const postTaxable = currentTaxable.plus(deltaTaxable);
          const postCgst = currentCgst.plus(deltaCgst);
          const postSgst = currentSgst.plus(deltaSgst);
          const postUtgst = currentUtgst.plus(deltaUtgst);
          const postIgst = currentIgst.plus(deltaIgst);
          const postTotal = currentTotal.plus(deltaTotal);

          // Verify capacity under lock
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

          // Atomically update invoice cumulative reversals
          await client.invoiceProcessingResult.update({
            where: { id: input.invoiceResultId },
            data: {
              cumulativeTaxableReversed: toDec2(postTaxable),
              cumulativeCgstReversed: toDec2(postCgst),
              cumulativeSgstReversed: toDec2(postSgst),
              cumulativeUtgstReversed: toDec2(postUtgst),
              cumulativeIgstReversed: toDec2(postIgst),
              cumulativeTotalReversed: toDec2(postTotal)
            }
          });

          // Create ledger entry for the reprocessed credit note result
          const rec = await client.reconciliation.create({
            data: {
              id: input.id || crypto.randomUUID(),
              organizationId: ctx.organizationId,
              importBatchId: input.importBatchId,
              creditNoteResultId: input.creditNoteResultId,
              invoiceResultId: input.invoiceResultId,
              reconciliationStatus: input.reconciliationStatus,
              taxableReversed: toDec2(input.taxableReversed),
              cgstReversed: toDec2(input.cgstReversed),
              sgstReversed: toDec2(input.sgstReversed),
              utgstReversed: toDec2(input.utgstReversed),
              igstReversed: toDec2(input.igstReversed),
              totalReversed: toDec2(input.totalReversed),
              priorCumulativeTaxable: toDec2(currentTaxable),
              postCumulativeTaxable: toDec2(postTaxable)
            }
          });

          // Update credit note result match status
          await client.creditNoteProcessingResult.update({
            where: { id: input.creditNoteResultId },
            data: {
              matchedInvoiceResultId: input.invoiceResultId,
              reconciliationStatus: input.reconciliationStatus
            }
          });

          return {
            reconciliation: this.mapReconciliation(rec),
            isSuperseded: true,
            appliedFinancialReversal: true,
            message: `Canonical credit note was previously reconciled under batch '${priorReconciliation.importBatchId}'. Superseded with financial delta adjustment.`
          };
        }

        // 5. First-time reconciliation: lock target invoice result to serialize cumulative updates
        const lockedInvoices: any[] = await client.$queryRaw`
          SELECT id, total_taxable_value, cgst_amount, sgst_amount, utgst_amount, igst_amount, total_invoice_amount,
                 cumulative_taxable_reversed, cumulative_cgst_reversed, cumulative_sgst_reversed,
                 cumulative_utgst_reversed, cumulative_igst_reversed, cumulative_total_reversed, reversal_count
          FROM invoice_processing_results
          WHERE id = ${input.invoiceResultId}::uuid AND organization_id = ${ctx.organizationId}::uuid
          FOR UPDATE;
        `;

        if (!lockedInvoices || lockedInvoices.length === 0) {
          throw new CanonicalDocumentNotFoundError(
            input.invoiceResultId,
            ctx.organizationId
          );
        }

        const invRow = lockedInvoices[0];
        const totalTaxable = fromDec(invRow.total_taxable_value);
        const totalCgst = fromDec(invRow.cgst_amount);
        const totalSgst = fromDec(invRow.sgst_amount);
        const totalUtgst = fromDec(invRow.utgst_amount);
        const totalIgst = fromDec(invRow.igst_amount);
        const totalInvoiceAmount = fromDec(invRow.total_invoice_amount);

        const currentTaxable = fromDec(invRow.cumulative_taxable_reversed);
        const currentCgst = fromDec(invRow.cumulative_cgst_reversed);
        const currentSgst = fromDec(invRow.cumulative_sgst_reversed);
        const currentUtgst = fromDec(invRow.cumulative_utgst_reversed);
        const currentIgst = fromDec(invRow.cumulative_igst_reversed);
        const currentTotal = fromDec(invRow.cumulative_total_reversed);

        const taxableToReverse = fromDec(input.taxableReversed);
        const cgstToReverse = fromDec(input.cgstReversed);
        const sgstToReverse = fromDec(input.sgstReversed);
        const utgstToReverse = fromDec(input.utgstReversed);
        const igstToReverse = fromDec(input.igstReversed);
        const totalToReverse = fromDec(input.totalReversed);

        const postTaxable = currentTaxable.plus(taxableToReverse);
        const postCgst = currentCgst.plus(cgstToReverse);
        const postSgst = currentSgst.plus(sgstToReverse);
        const postUtgst = currentUtgst.plus(utgstToReverse);
        const postIgst = currentIgst.plus(igstToReverse);
        const postTotal = currentTotal.plus(totalToReverse);

        // Verify capacity under lock
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

        // 6. Create reconciliation entry
        const rec = await client.reconciliation.create({
          data: {
            id: input.id || crypto.randomUUID(),
            organizationId: ctx.organizationId,
            importBatchId: input.importBatchId,
            creditNoteResultId: input.creditNoteResultId,
            invoiceResultId: input.invoiceResultId,
            reconciliationStatus: input.reconciliationStatus,
            taxableReversed: toDec2(input.taxableReversed),
            cgstReversed: toDec2(input.cgstReversed),
            sgstReversed: toDec2(input.sgstReversed),
            utgstReversed: toDec2(input.utgstReversed),
            igstReversed: toDec2(input.igstReversed),
            totalReversed: toDec2(input.totalReversed),
            priorCumulativeTaxable: toDec2(currentTaxable),
            postCumulativeTaxable: toDec2(postTaxable)
          }
        });

        // 7. Atomically update invoice cumulative reversals
        await client.invoiceProcessingResult.update({
          where: { id: input.invoiceResultId },
          data: {
            cumulativeTaxableReversed: toDec2(postTaxable),
            cumulativeCgstReversed: toDec2(postCgst),
            cumulativeSgstReversed: toDec2(postSgst),
            cumulativeUtgstReversed: toDec2(postUtgst),
            cumulativeIgstReversed: toDec2(postIgst),
            cumulativeTotalReversed: toDec2(postTotal),
            reversalCount: { increment: 1 }
          }
        });

        // 8. Update credit note result match status
        await client.creditNoteProcessingResult.update({
          where: { id: input.creditNoteResultId },
          data: {
            matchedInvoiceResultId: input.invoiceResultId,
            reconciliationStatus: input.reconciliationStatus
          }
        });

        return {
          reconciliation: this.mapReconciliation(rec),
          isSuperseded: false,
          appliedFinancialReversal: true
        };
      },
      tx
    );
  }

  public async findReconciliationByCreditNoteResultId(
    ctx: TenantContext,
    creditNoteResultId: string,
    tx?: Prisma.TransactionClient
  ): Promise<ReconciliationEntity | null> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const row = await client.reconciliation.findFirst({
          where: { creditNoteResultId, organizationId: ctx.organizationId }
        });
        return row ? this.mapReconciliation(row) : null;
      },
      tx
    );
  }

  public async findReconciliationsByInvoiceResultId(
    ctx: TenantContext,
    invoiceResultId: string,
    tx?: Prisma.TransactionClient
  ): Promise<ReconciliationEntity[]> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const rows = await client.reconciliation.findMany({
          where: { invoiceResultId, organizationId: ctx.organizationId },
          orderBy: { appliedAt: 'asc' }
        });
        return rows.map((r) => this.mapReconciliation(r));
      },
      tx
    );
  }

  public async findPriorReconciliationForCanonicalCreditNote(
    ctx: TenantContext,
    canonicalCreditNoteId: string,
    tx?: Prisma.TransactionClient
  ): Promise<ReconciliationEntity | null> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const row = await client.reconciliation.findFirst({
          where: {
            organizationId: ctx.organizationId,
            creditNoteResult: {
              canonicalCreditNoteId
            }
          },
          orderBy: { appliedAt: 'desc' }
        });
        return row ? this.mapReconciliation(row) : null;
      },
      tx
    );
  }

  private mapReconciliation(row: any): ReconciliationEntity {
    return {
      id: row.id,
      organizationId: row.organizationId,
      importBatchId: row.importBatchId,
      creditNoteResultId: row.creditNoteResultId,
      invoiceResultId: row.invoiceResultId,
      reconciliationStatus: row.reconciliationStatus,
      taxableReversed: fromDec(row.taxableReversed),
      cgstReversed: fromDec(row.cgstReversed),
      sgstReversed: fromDec(row.sgstReversed),
      utgstReversed: fromDec(row.utgstReversed),
      igstReversed: fromDec(row.igstReversed),
      totalReversed: fromDec(row.totalReversed),
      priorCumulativeTaxable: fromDec(row.priorCumulativeTaxable),
      postCumulativeTaxable: fromDec(row.postCumulativeTaxable),
      appliedAt: row.appliedAt
    };
  }
}
