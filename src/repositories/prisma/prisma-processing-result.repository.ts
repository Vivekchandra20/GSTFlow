import crypto from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { Decimal } from '../../utils/decimal.js';
import {
  IProcessingResultRepository,
  TenantContext,
  CreateInvoiceProcessingResultInput,
  InvoiceProcessingResultEntity,
  InvoiceLineEntity,
  CreateCreditNoteProcessingResultInput,
  CreditNoteProcessingResultEntity,
  CreateStockTransferProcessingResultInput,
  StockTransferProcessingResultEntity,
  NumericField,
  DuplicateProcessingResultError,
  CanonicalDocumentNotFoundError
} from '../types.js';
import { runInTenantTransaction } from './tenant-context.js';

function toDec2(v: NumericField | undefined | null): string {
  if (v === undefined || v === null) return '0.00';
  return new Decimal(v).toFixed(2);
}

function toDec3(v: NumericField | undefined | null): string {
  if (v === undefined || v === null) return '0.000';
  return new Decimal(v).toFixed(3);
}

function toDec4(v: NumericField | undefined | null): string {
  if (v === undefined || v === null) return '0.0000';
  return new Decimal(v).toFixed(4);
}

function fromDec(v: any): Decimal {
  return new Decimal(v ? v.toString() : '0');
}

export class PrismaProcessingResultRepository implements IProcessingResultRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // ==========================================
  // INVOICE PROCESSING RESULTS & LINES
  // ==========================================

  public async createInvoiceResult(
    ctx: TenantContext,
    input: CreateInvoiceProcessingResultInput,
    tx?: Prisma.TransactionClient
  ): Promise<InvoiceProcessingResultEntity> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        // 1. Verify canonical document exists for this organization
        const canonical = await client.canonicalInvoice.findFirst({
          where: { id: input.canonicalInvoiceId, organizationId: ctx.organizationId }
        });
        if (!canonical) {
          throw new CanonicalDocumentNotFoundError(
            input.canonicalInvoiceId,
            ctx.organizationId
          );
        }

        // 2. Lock canonical invoice row to serialize concurrent execution version allocation
        await client.$executeRaw`
          SELECT id FROM canonical_invoices
          WHERE id = ${input.canonicalInvoiceId}::uuid AND organization_id = ${ctx.organizationId}::uuid
          FOR UPDATE;
        `;

        // 3. Pre-check for duplicate execution result in same batch (prohibit silent overwrite)
        const existing = await client.invoiceProcessingResult.findFirst({
          where: {
            organizationId: ctx.organizationId,
            importBatchId: input.importBatchId,
            canonicalInvoiceId: input.canonicalInvoiceId
          }
        });
        if (existing) {
          throw new DuplicateProcessingResultError(
            ctx.organizationId,
            input.importBatchId,
            input.canonicalInvoiceId
          );
        }

        // 4. Compute version: if not provided, increment from existing versions
        let version = input.version;
        if (!version) {
          const prior = await client.invoiceProcessingResult.findMany({
            where: {
              organizationId: ctx.organizationId,
              canonicalInvoiceId: input.canonicalInvoiceId
            },
            orderBy: { version: 'desc' },
            take: 1
          });
          version = prior.length > 0 ? prior[0].version + 1 : 1;
        }

        const resultId = input.id || crypto.randomUUID();

        // 4. Create the processing result
        const created = await client.invoiceProcessingResult.create({
          data: {
            id: resultId,
            organizationId: ctx.organizationId,
            importBatchId: input.importBatchId,
            canonicalInvoiceId: input.canonicalInvoiceId,
            sourceRecordId: input.sourceRecordId,
            totalTaxableValue: toDec2(input.totalTaxableValue),
            shippingTaxableValue: toDec2(input.shippingTaxableValue),
            cgstAmount: toDec2(input.cgstAmount),
            sgstAmount: toDec2(input.sgstAmount),
            utgstAmount: toDec2(input.utgstAmount),
            igstAmount: toDec2(input.igstAmount),
            cessAmount: toDec2(input.cessAmount),
            totalInvoiceAmount: toDec2(input.totalInvoiceAmount),
            reportedTcsCgst: toDec2(input.reportedTcsCgst),
            reportedTcsSgst: toDec2(input.reportedTcsSgst),
            reportedTcsIgst: toDec2(input.reportedTcsIgst),
            calculatedTcsCgst: toDec2(input.calculatedTcsCgst),
            calculatedTcsSgst: toDec2(input.calculatedTcsSgst),
            calculatedTcsIgst: toDec2(input.calculatedTcsIgst),
            primaryOutcome: input.primaryOutcome,
            version
          }
        });

        // 5. Create invoice lines
        if (input.lines && input.lines.length > 0) {
          const lineData: Prisma.InvoiceLineCreateManyInput[] = input.lines.map((l) => ({
            id: l.id || crypto.randomUUID(),
            organizationId: ctx.organizationId,
            invoiceResultId: resultId,
            sourceRecordId: l.sourceRecordId,
            lineNumber: l.lineNumber,
            sku: l.sku || null,
            asin: l.asin || null,
            hsnSac: l.hsnSac || null,
            productCategory: l.productCategory || null,
            quantity: toDec3(l.quantity),
            unitPrice: l.unitPrice !== undefined && l.unitPrice !== null ? toDec4(l.unitPrice) : null,
            itemTaxableValue: toDec2(l.itemTaxableValue),
            shippingTaxableValue: toDec2(l.shippingTaxableValue),
            giftWrapTaxableValue: toDec2(l.giftWrapTaxableValue),
            itemPromoDiscount: toDec2(l.itemPromoDiscount),
            taxRate: toDec4(l.taxRate),
            cgstRate: toDec4(l.cgstRate),
            cgstAmount: toDec2(l.cgstAmount),
            sgstRate: toDec4(l.sgstRate),
            sgstAmount: toDec2(l.sgstAmount),
            utgstRate: toDec4(l.utgstRate),
            utgstAmount: toDec2(l.utgstAmount),
            igstRate: toDec4(l.igstRate),
            igstAmount: toDec2(l.igstAmount),
            cessAmount: toDec2(l.cessAmount),
            totalLineAmount: toDec2(l.totalLineAmount),
            amazonMetadata: (l.amazonMetadata || Prisma.JsonNull) as Prisma.InputJsonValue
          }));

          await client.invoiceLine.createMany({ data: lineData });
        }

        const lines = await client.invoiceLine.findMany({
          where: { invoiceResultId: resultId, organizationId: ctx.organizationId },
          orderBy: { lineNumber: 'asc' }
        });

        return this.mapInvoiceResult(created, lines);
      },
      tx
    );
  }

  public async findInvoiceResultByBatchAndCanonicalId(
    ctx: TenantContext,
    importBatchId: string,
    canonicalInvoiceId: string,
    tx?: Prisma.TransactionClient
  ): Promise<InvoiceProcessingResultEntity | null> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const row = await client.invoiceProcessingResult.findFirst({
          where: {
            organizationId: ctx.organizationId,
            importBatchId,
            canonicalInvoiceId
          },
          include: {
            lines: {
              orderBy: { lineNumber: 'asc' }
            }
          }
        });
        return row ? this.mapInvoiceResult(row, row.lines) : null;
      },
      tx
    );
  }

  public async findInvoiceResultById(
    ctx: TenantContext,
    id: string,
    tx?: Prisma.TransactionClient
  ): Promise<InvoiceProcessingResultEntity | null> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const row = await client.invoiceProcessingResult.findFirst({
          where: { id, organizationId: ctx.organizationId },
          include: {
            lines: {
              orderBy: { lineNumber: 'asc' }
            }
          }
        });
        return row ? this.mapInvoiceResult(row, row.lines) : null;
      },
      tx
    );
  }

  public async findInvoiceResultsByCanonicalInvoice(
    ctx: TenantContext,
    canonicalInvoiceId: string,
    tx?: Prisma.TransactionClient
  ): Promise<InvoiceProcessingResultEntity[]> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const rows = await client.invoiceProcessingResult.findMany({
          where: {
            organizationId: ctx.organizationId,
            canonicalInvoiceId
          },
          include: {
            lines: {
              orderBy: { lineNumber: 'asc' }
            }
          },
          orderBy: { version: 'asc' }
        });
        return rows.map((r) => this.mapInvoiceResult(r, r.lines));
      },
      tx
    );
  }

  // ==========================================
  // CREDIT NOTE PROCESSING RESULTS
  // ==========================================

  public async createCreditNoteResult(
    ctx: TenantContext,
    input: CreateCreditNoteProcessingResultInput,
    tx?: Prisma.TransactionClient
  ): Promise<CreditNoteProcessingResultEntity> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const canonical = await client.canonicalCreditNote.findFirst({
          where: { id: input.canonicalCreditNoteId, organizationId: ctx.organizationId }
        });
        if (!canonical) {
          throw new CanonicalDocumentNotFoundError(
            input.canonicalCreditNoteId,
            ctx.organizationId
          );
        }

        const existing = await client.creditNoteProcessingResult.findFirst({
          where: {
            organizationId: ctx.organizationId,
            importBatchId: input.importBatchId,
            canonicalCreditNoteId: input.canonicalCreditNoteId
          }
        });
        if (existing) {
          throw new DuplicateProcessingResultError(
            ctx.organizationId,
            input.importBatchId,
            input.canonicalCreditNoteId
          );
        }

        const created = await client.creditNoteProcessingResult.create({
          data: {
            id: input.id || crypto.randomUUID(),
            organizationId: ctx.organizationId,
            importBatchId: input.importBatchId,
            canonicalCreditNoteId: input.canonicalCreditNoteId,
            sourceRecordId: input.sourceRecordId,
            matchedInvoiceResultId: input.matchedInvoiceResultId || null,
            taxableValueReversal: toDec2(input.taxableValueReversal),
            cgstAmountReversal: toDec2(input.cgstAmountReversal),
            sgstAmountReversal: toDec2(input.sgstAmountReversal),
            utgstAmountReversal: toDec2(input.utgstAmountReversal),
            igstAmountReversal: toDec2(input.igstAmountReversal),
            creditNoteTotal: toDec2(input.creditNoteTotal),
            rawSignedAmountText: input.rawSignedAmountText,
            signedAmount: toDec2(input.signedAmount),
            reconciliationStatus: (input.reconciliationStatus || 'UNMATCHED_ORPHAN') as any,
            primaryOutcome: input.primaryOutcome
          }
        });

        return this.mapCreditNoteResult(created);
      },
      tx
    );
  }

  public async findCreditNoteResultByBatchAndCanonicalId(
    ctx: TenantContext,
    importBatchId: string,
    canonicalCreditNoteId: string,
    tx?: Prisma.TransactionClient
  ): Promise<CreditNoteProcessingResultEntity | null> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const row = await client.creditNoteProcessingResult.findFirst({
          where: {
            organizationId: ctx.organizationId,
            importBatchId,
            canonicalCreditNoteId
          }
        });
        return row ? this.mapCreditNoteResult(row) : null;
      },
      tx
    );
  }

  public async findCreditNoteResultById(
    ctx: TenantContext,
    id: string,
    tx?: Prisma.TransactionClient
  ): Promise<CreditNoteProcessingResultEntity | null> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const row = await client.creditNoteProcessingResult.findFirst({
          where: { id, organizationId: ctx.organizationId }
        });
        return row ? this.mapCreditNoteResult(row) : null;
      },
      tx
    );
  }

  public async findCreditNoteResultsByCanonicalCreditNote(
    ctx: TenantContext,
    canonicalCreditNoteId: string,
    tx?: Prisma.TransactionClient
  ): Promise<CreditNoteProcessingResultEntity[]> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const rows = await client.creditNoteProcessingResult.findMany({
          where: {
            organizationId: ctx.organizationId,
            canonicalCreditNoteId
          },
          orderBy: { createdAt: 'asc' }
        });
        return rows.map((r) => this.mapCreditNoteResult(r));
      },
      tx
    );
  }

  // ==========================================
  // STOCK TRANSFER PROCESSING RESULTS
  // ==========================================

  public async createStockTransferResult(
    ctx: TenantContext,
    input: CreateStockTransferProcessingResultInput,
    tx?: Prisma.TransactionClient
  ): Promise<StockTransferProcessingResultEntity> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const canonical = await client.canonicalStockTransfer.findFirst({
          where: { id: input.canonicalTransferId, organizationId: ctx.organizationId }
        });
        if (!canonical) {
          throw new CanonicalDocumentNotFoundError(
            input.canonicalTransferId,
            ctx.organizationId
          );
        }

        const existing = await client.stockTransferProcessingResult.findFirst({
          where: {
            organizationId: ctx.organizationId,
            importBatchId: input.importBatchId,
            canonicalTransferId: input.canonicalTransferId
          }
        });
        if (existing) {
          throw new DuplicateProcessingResultError(
            ctx.organizationId,
            input.importBatchId,
            input.canonicalTransferId
          );
        }

        const created = await client.stockTransferProcessingResult.create({
          data: {
            id: input.id || crypto.randomUUID(),
            organizationId: ctx.organizationId,
            importBatchId: input.importBatchId,
            canonicalTransferId: input.canonicalTransferId,
            sourceRecordId: input.sourceRecordId,
            classification: input.classification,
            quantity: toDec3(input.quantity),
            taxableValue: toDec2(input.taxableValue),
            cgstAmount: toDec2(input.cgstAmount),
            sgstAmount: toDec2(input.sgstAmount),
            utgstAmount: toDec2(input.utgstAmount),
            igstAmount: toDec2(input.igstAmount),
            cessAmount: toDec2(input.cessAmount),
            totalInvoiceAmount: toDec2(input.totalInvoiceAmount),
            primaryOutcome: input.primaryOutcome
          }
        });

        return this.mapTransferResult(created);
      },
      tx
    );
  }

  public async findStockTransferResultByBatchAndCanonicalId(
    ctx: TenantContext,
    importBatchId: string,
    canonicalTransferId: string,
    tx?: Prisma.TransactionClient
  ): Promise<StockTransferProcessingResultEntity | null> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const row = await client.stockTransferProcessingResult.findFirst({
          where: {
            organizationId: ctx.organizationId,
            importBatchId,
            canonicalTransferId
          }
        });
        return row ? this.mapTransferResult(row) : null;
      },
      tx
    );
  }

  public async findStockTransferResultById(
    ctx: TenantContext,
    id: string,
    tx?: Prisma.TransactionClient
  ): Promise<StockTransferProcessingResultEntity | null> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const row = await client.stockTransferProcessingResult.findFirst({
          where: { id, organizationId: ctx.organizationId }
        });
        return row ? this.mapTransferResult(row) : null;
      },
      tx
    );
  }

  public async findStockTransferResultsByCanonicalTransfer(
    ctx: TenantContext,
    canonicalTransferId: string,
    tx?: Prisma.TransactionClient
  ): Promise<StockTransferProcessingResultEntity[]> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const rows = await client.stockTransferProcessingResult.findMany({
          where: {
            organizationId: ctx.organizationId,
            canonicalTransferId
          },
          orderBy: { createdAt: 'asc' }
        });
        return rows.map((r) => this.mapTransferResult(r));
      },
      tx
    );
  }

  // ==========================================
  // MAPPER FUNCTIONS
  // ==========================================

  private mapInvoiceResult(row: any, lineRows: any[] = []): InvoiceProcessingResultEntity {
    return {
      id: row.id,
      organizationId: row.organizationId,
      importBatchId: row.importBatchId,
      canonicalInvoiceId: row.canonicalInvoiceId,
      sourceRecordId: row.sourceRecordId,
      totalTaxableValue: fromDec(row.totalTaxableValue),
      shippingTaxableValue: fromDec(row.shippingTaxableValue),
      cgstAmount: fromDec(row.cgstAmount),
      sgstAmount: fromDec(row.sgstAmount),
      utgstAmount: fromDec(row.utgstAmount),
      igstAmount: fromDec(row.igstAmount),
      cessAmount: fromDec(row.cessAmount),
      totalInvoiceAmount: fromDec(row.totalInvoiceAmount),
      reportedTcsCgst: fromDec(row.reportedTcsCgst),
      reportedTcsSgst: fromDec(row.reportedTcsSgst),
      reportedTcsIgst: fromDec(row.reportedTcsIgst),
      calculatedTcsCgst: fromDec(row.calculatedTcsCgst),
      calculatedTcsSgst: fromDec(row.calculatedTcsSgst),
      calculatedTcsIgst: fromDec(row.calculatedTcsIgst),
      cumulativeTaxableReversed: fromDec(row.cumulativeTaxableReversed),
      cumulativeCgstReversed: fromDec(row.cumulativeCgstReversed),
      cumulativeSgstReversed: fromDec(row.cumulativeSgstReversed),
      cumulativeUtgstReversed: fromDec(row.cumulativeUtgstReversed),
      cumulativeIgstReversed: fromDec(row.cumulativeIgstReversed),
      cumulativeTotalReversed: fromDec(row.cumulativeTotalReversed),
      reversalCount: row.reversalCount,
      primaryOutcome: row.primaryOutcome,
      version: row.version,
      createdAt: row.createdAt,
      lines: lineRows.map((l) => ({
        id: l.id,
        organizationId: l.organizationId,
        invoiceResultId: l.invoiceResultId,
        sourceRecordId: l.sourceRecordId,
        lineNumber: l.lineNumber,
        sku: l.sku,
        asin: l.asin,
        hsnSac: l.hsnSac,
        productCategory: l.productCategory,
        quantity: fromDec(l.quantity),
        unitPrice: l.unitPrice ? fromDec(l.unitPrice) : null,
        itemTaxableValue: fromDec(l.itemTaxableValue),
        shippingTaxableValue: fromDec(l.shippingTaxableValue),
        giftWrapTaxableValue: fromDec(l.giftWrapTaxableValue),
        itemPromoDiscount: fromDec(l.itemPromoDiscount),
        taxRate: fromDec(l.taxRate),
        cgstRate: fromDec(l.cgstRate),
        cgstAmount: fromDec(l.cgstAmount),
        sgstRate: fromDec(l.sgstRate),
        sgstAmount: fromDec(l.sgstAmount),
        utgstRate: fromDec(l.utgstRate),
        utgstAmount: fromDec(l.utgstAmount),
        igstRate: fromDec(l.igstRate),
        igstAmount: fromDec(l.igstAmount),
        cessAmount: fromDec(l.cessAmount),
        totalLineAmount: fromDec(l.totalLineAmount),
        amazonMetadata: l.amazonMetadata,
        createdAt: l.createdAt
      }))
    };
  }

  private mapCreditNoteResult(row: any): CreditNoteProcessingResultEntity {
    return {
      id: row.id,
      organizationId: row.organizationId,
      importBatchId: row.importBatchId,
      canonicalCreditNoteId: row.canonicalCreditNoteId,
      sourceRecordId: row.sourceRecordId,
      matchedInvoiceResultId: row.matchedInvoiceResultId,
      taxableValueReversal: fromDec(row.taxableValueReversal),
      cgstAmountReversal: fromDec(row.cgstAmountReversal),
      sgstAmountReversal: fromDec(row.sgstAmountReversal),
      utgstAmountReversal: fromDec(row.utgstAmountReversal),
      igstAmountReversal: fromDec(row.igstAmountReversal),
      creditNoteTotal: fromDec(row.creditNoteTotal),
      rawSignedAmountText: row.rawSignedAmountText,
      signedAmount: fromDec(row.signedAmount),
      reconciliationStatus: row.reconciliationStatus,
      primaryOutcome: row.primaryOutcome,
      createdAt: row.createdAt
    };
  }

  private mapTransferResult(row: any): StockTransferProcessingResultEntity {
    return {
      id: row.id,
      organizationId: row.organizationId,
      importBatchId: row.importBatchId,
      canonicalTransferId: row.canonicalTransferId,
      sourceRecordId: row.sourceRecordId,
      classification: row.classification,
      quantity: fromDec(row.quantity),
      taxableValue: fromDec(row.taxableValue),
      cgstAmount: fromDec(row.cgstAmount),
      sgstAmount: fromDec(row.sgstAmount),
      utgstAmount: fromDec(row.utgstAmount),
      igstAmount: fromDec(row.igstAmount),
      cessAmount: fromDec(row.cessAmount),
      totalInvoiceAmount: fromDec(row.totalInvoiceAmount),
      primaryOutcome: row.primaryOutcome,
      createdAt: row.createdAt
    };
  }
}
