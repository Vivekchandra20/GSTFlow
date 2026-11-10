import crypto from 'crypto';
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
  DuplicateProcessingResultError,
  TenantAuthorizationError
} from '../types.js';
import { ReconciliationStatus } from '../../models/enums.js';

function toDec(v: any, defaultVal: string = '0'): Decimal {
  if (v === undefined || v === null) return new Decimal(defaultVal);
  return new Decimal(v);
}

export class InMemoryProcessingResultRepository implements IProcessingResultRepository {
  private invoiceResultsById = new Map<string, InvoiceProcessingResultEntity>();
  private invoiceResultsByBatchAndDoc = new Map<string, InvoiceProcessingResultEntity>();

  private creditNoteResultsById = new Map<string, CreditNoteProcessingResultEntity>();
  private creditNoteResultsByBatchAndDoc = new Map<string, CreditNoteProcessingResultEntity>();

  private transferResultsById = new Map<string, StockTransferProcessingResultEntity>();
  private transferResultsByBatchAndDoc = new Map<string, StockTransferProcessingResultEntity>();

  public reset(): void {
    this.invoiceResultsById.clear();
    this.invoiceResultsByBatchAndDoc.clear();
    this.creditNoteResultsById.clear();
    this.creditNoteResultsByBatchAndDoc.clear();
    this.transferResultsById.clear();
    this.transferResultsByBatchAndDoc.clear();
  }

  private validateTenant(ctx: TenantContext): void {
    if (!ctx || !ctx.organizationId) {
      throw new TenantAuthorizationError('Tenant context is missing or invalid.');
    }
  }

  // ==========================================
  // INVOICE PROCESSING RESULTS
  // ==========================================

  public async createInvoiceResult(
    ctx: TenantContext,
    input: CreateInvoiceProcessingResultInput
  ): Promise<InvoiceProcessingResultEntity> {
    this.validateTenant(ctx);

    const batchKey = `${ctx.organizationId}#${input.importBatchId}#${input.canonicalInvoiceId}`;
    if (this.invoiceResultsByBatchAndDoc.has(batchKey)) {
      throw new DuplicateProcessingResultError(
        ctx.organizationId,
        input.importBatchId,
        input.canonicalInvoiceId
      );
    }

    let version = input.version;
    if (!version) {
      const prior = await this.findInvoiceResultsByCanonicalInvoice(
        ctx,
        input.canonicalInvoiceId
      );
      version = prior.length > 0 ? prior[prior.length - 1].version + 1 : 1;
    }

    const resultId = input.id || crypto.randomUUID();

    const lines: InvoiceLineEntity[] = (input.lines || []).map((l) => ({
      id: l.id || crypto.randomUUID(),
      organizationId: ctx.organizationId,
      invoiceResultId: resultId,
      sourceRecordId: l.sourceRecordId,
      lineNumber: l.lineNumber,
      sku: l.sku || null,
      asin: l.asin || null,
      hsnSac: l.hsnSac || null,
      productCategory: l.productCategory || null,
      quantity: toDec(l.quantity, '1.000'),
      unitPrice: l.unitPrice !== undefined && l.unitPrice !== null ? toDec(l.unitPrice) : null,
      itemTaxableValue: toDec(l.itemTaxableValue),
      shippingTaxableValue: toDec(l.shippingTaxableValue),
      giftWrapTaxableValue: toDec(l.giftWrapTaxableValue),
      itemPromoDiscount: toDec(l.itemPromoDiscount),
      taxRate: toDec(l.taxRate),
      cgstRate: toDec(l.cgstRate),
      cgstAmount: toDec(l.cgstAmount),
      sgstRate: toDec(l.sgstRate),
      sgstAmount: toDec(l.sgstAmount),
      utgstRate: toDec(l.utgstRate),
      utgstAmount: toDec(l.utgstAmount),
      igstRate: toDec(l.igstRate),
      igstAmount: toDec(l.igstAmount),
      cessAmount: toDec(l.cessAmount),
      totalLineAmount: toDec(l.totalLineAmount),
      amazonMetadata: l.amazonMetadata || null,
      createdAt: new Date()
    }));

    lines.sort((a, b) => a.lineNumber - b.lineNumber);

    const entity: InvoiceProcessingResultEntity = {
      id: resultId,
      organizationId: ctx.organizationId,
      importBatchId: input.importBatchId,
      canonicalInvoiceId: input.canonicalInvoiceId,
      sourceRecordId: input.sourceRecordId,
      totalTaxableValue: toDec(input.totalTaxableValue),
      shippingTaxableValue: toDec(input.shippingTaxableValue),
      cgstAmount: toDec(input.cgstAmount),
      sgstAmount: toDec(input.sgstAmount),
      utgstAmount: toDec(input.utgstAmount),
      igstAmount: toDec(input.igstAmount),
      cessAmount: toDec(input.cessAmount),
      totalInvoiceAmount: toDec(input.totalInvoiceAmount),
      reportedTcsCgst: toDec(input.reportedTcsCgst),
      reportedTcsSgst: toDec(input.reportedTcsSgst),
      reportedTcsIgst: toDec(input.reportedTcsIgst),
      calculatedTcsCgst: toDec(input.calculatedTcsCgst),
      calculatedTcsSgst: toDec(input.calculatedTcsSgst),
      calculatedTcsIgst: toDec(input.calculatedTcsIgst),
      cumulativeTaxableReversed: new Decimal(0),
      cumulativeCgstReversed: new Decimal(0),
      cumulativeSgstReversed: new Decimal(0),
      cumulativeUtgstReversed: new Decimal(0),
      cumulativeIgstReversed: new Decimal(0),
      cumulativeTotalReversed: new Decimal(0),
      reversalCount: 0,
      primaryOutcome: input.primaryOutcome,
      version,
      createdAt: new Date(),
      lines
    };

    this.invoiceResultsById.set(`${ctx.organizationId}#${resultId}`, entity);
    this.invoiceResultsByBatchAndDoc.set(batchKey, entity);
    return entity;
  }

  public async findInvoiceResultByBatchAndCanonicalId(
    ctx: TenantContext,
    importBatchId: string,
    canonicalInvoiceId: string
  ): Promise<InvoiceProcessingResultEntity | null> {
    this.validateTenant(ctx);
    const key = `${ctx.organizationId}#${importBatchId}#${canonicalInvoiceId}`;
    return this.invoiceResultsByBatchAndDoc.get(key) || null;
  }

  public async findInvoiceResultById(
    ctx: TenantContext,
    id: string
  ): Promise<InvoiceProcessingResultEntity | null> {
    this.validateTenant(ctx);
    return this.invoiceResultsById.get(`${ctx.organizationId}#${id}`) || null;
  }

  public async findInvoiceResultsByCanonicalInvoice(
    ctx: TenantContext,
    canonicalInvoiceId: string
  ): Promise<InvoiceProcessingResultEntity[]> {
    this.validateTenant(ctx);
    const list: InvoiceProcessingResultEntity[] = [];
    for (const res of this.invoiceResultsById.values()) {
      if (
        res.organizationId === ctx.organizationId &&
        res.canonicalInvoiceId === canonicalInvoiceId
      ) {
        list.push(res);
      }
    }
    list.sort((a, b) => a.version - b.version);
    return list;
  }

  // ==========================================
  // CREDIT NOTE PROCESSING RESULTS
  // ==========================================

  public async createCreditNoteResult(
    ctx: TenantContext,
    input: CreateCreditNoteProcessingResultInput
  ): Promise<CreditNoteProcessingResultEntity> {
    this.validateTenant(ctx);

    const batchKey = `${ctx.organizationId}#${input.importBatchId}#${input.canonicalCreditNoteId}`;
    if (this.creditNoteResultsByBatchAndDoc.has(batchKey)) {
      throw new DuplicateProcessingResultError(
        ctx.organizationId,
        input.importBatchId,
        input.canonicalCreditNoteId
      );
    }

    const resultId = input.id || crypto.randomUUID();
    const entity: CreditNoteProcessingResultEntity = {
      id: resultId,
      organizationId: ctx.organizationId,
      importBatchId: input.importBatchId,
      canonicalCreditNoteId: input.canonicalCreditNoteId,
      sourceRecordId: input.sourceRecordId,
      matchedInvoiceResultId: input.matchedInvoiceResultId || null,
      taxableValueReversal: toDec(input.taxableValueReversal),
      cgstAmountReversal: toDec(input.cgstAmountReversal),
      sgstAmountReversal: toDec(input.sgstAmountReversal),
      utgstAmountReversal: toDec(input.utgstAmountReversal),
      igstAmountReversal: toDec(input.igstAmountReversal),
      creditNoteTotal: toDec(input.creditNoteTotal),
      rawSignedAmountText: input.rawSignedAmountText,
      signedAmount: toDec(input.signedAmount),
      reconciliationStatus: input.reconciliationStatus || ReconciliationStatus.UNMATCHED_ORPHAN,
      primaryOutcome: input.primaryOutcome,
      createdAt: new Date()
    };

    this.creditNoteResultsById.set(`${ctx.organizationId}#${resultId}`, entity);
    this.creditNoteResultsByBatchAndDoc.set(batchKey, entity);
    return entity;
  }

  public async findCreditNoteResultByBatchAndCanonicalId(
    ctx: TenantContext,
    importBatchId: string,
    canonicalCreditNoteId: string
  ): Promise<CreditNoteProcessingResultEntity | null> {
    this.validateTenant(ctx);
    const key = `${ctx.organizationId}#${importBatchId}#${canonicalCreditNoteId}`;
    return this.creditNoteResultsByBatchAndDoc.get(key) || null;
  }

  public async findCreditNoteResultById(
    ctx: TenantContext,
    id: string
  ): Promise<CreditNoteProcessingResultEntity | null> {
    this.validateTenant(ctx);
    return this.creditNoteResultsById.get(`${ctx.organizationId}#${id}`) || null;
  }

  public async findCreditNoteResultsByCanonicalCreditNote(
    ctx: TenantContext,
    canonicalCreditNoteId: string
  ): Promise<CreditNoteProcessingResultEntity[]> {
    this.validateTenant(ctx);
    const list: CreditNoteProcessingResultEntity[] = [];
    for (const res of this.creditNoteResultsById.values()) {
      if (
        res.organizationId === ctx.organizationId &&
        res.canonicalCreditNoteId === canonicalCreditNoteId
      ) {
        list.push(res);
      }
    }
    list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return list;
  }

  // ==========================================
  // STOCK TRANSFER PROCESSING RESULTS
  // ==========================================

  public async createStockTransferResult(
    ctx: TenantContext,
    input: CreateStockTransferProcessingResultInput
  ): Promise<StockTransferProcessingResultEntity> {
    this.validateTenant(ctx);

    const batchKey = `${ctx.organizationId}#${input.importBatchId}#${input.canonicalTransferId}`;
    if (this.transferResultsByBatchAndDoc.has(batchKey)) {
      throw new DuplicateProcessingResultError(
        ctx.organizationId,
        input.importBatchId,
        input.canonicalTransferId
      );
    }

    const resultId = input.id || crypto.randomUUID();
    const entity: StockTransferProcessingResultEntity = {
      id: resultId,
      organizationId: ctx.organizationId,
      importBatchId: input.importBatchId,
      canonicalTransferId: input.canonicalTransferId,
      sourceRecordId: input.sourceRecordId,
      classification: input.classification,
      quantity: toDec(input.quantity, '1.000'),
      taxableValue: toDec(input.taxableValue),
      cgstAmount: toDec(input.cgstAmount),
      sgstAmount: toDec(input.sgstAmount),
      utgstAmount: toDec(input.utgstAmount),
      igstAmount: toDec(input.igstAmount),
      cessAmount: toDec(input.cessAmount),
      totalInvoiceAmount: toDec(input.totalInvoiceAmount),
      primaryOutcome: input.primaryOutcome,
      createdAt: new Date()
    };

    this.transferResultsById.set(`${ctx.organizationId}#${resultId}`, entity);
    this.transferResultsByBatchAndDoc.set(batchKey, entity);
    return entity;
  }

  public async findStockTransferResultByBatchAndCanonicalId(
    ctx: TenantContext,
    importBatchId: string,
    canonicalTransferId: string
  ): Promise<StockTransferProcessingResultEntity | null> {
    this.validateTenant(ctx);
    const key = `${ctx.organizationId}#${importBatchId}#${canonicalTransferId}`;
    return this.transferResultsByBatchAndDoc.get(key) || null;
  }

  public async findStockTransferResultById(
    ctx: TenantContext,
    id: string
  ): Promise<StockTransferProcessingResultEntity | null> {
    this.validateTenant(ctx);
    return this.transferResultsById.get(`${ctx.organizationId}#${id}`) || null;
  }

  public async findStockTransferResultsByCanonicalTransfer(
    ctx: TenantContext,
    canonicalTransferId: string
  ): Promise<StockTransferProcessingResultEntity[]> {
    this.validateTenant(ctx);
    const list: StockTransferProcessingResultEntity[] = [];
    for (const res of this.transferResultsById.values()) {
      if (
        res.organizationId === ctx.organizationId &&
        res.canonicalTransferId === canonicalTransferId
      ) {
        list.push(res);
      }
    }
    list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return list;
  }
}
