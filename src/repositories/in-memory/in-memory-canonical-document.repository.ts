import crypto from 'crypto';
import {
  ICanonicalDocumentRepository,
  TenantContext,
  CreateCanonicalInvoiceInput,
  CanonicalInvoiceEntity,
  CanonicalInvoiceResult,
  CreateCanonicalCreditNoteInput,
  CanonicalCreditNoteEntity,
  CanonicalCreditNoteResult,
  CreateCanonicalStockTransferInput,
  CanonicalStockTransferEntity,
  CanonicalStockTransferResult,
  DocumentConflictDetail,
  TenantAuthorizationError
} from '../types.js';

function toDateStr(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return new Date(d).toISOString().slice(0, 10);
}

export class InMemoryCanonicalDocumentRepository implements ICanonicalDocumentRepository {
  private invoicesByKey = new Map<string, CanonicalInvoiceEntity>();
  private invoicesById = new Map<string, CanonicalInvoiceEntity>();

  private creditNotesByKey = new Map<string, CanonicalCreditNoteEntity>();
  private creditNotesById = new Map<string, CanonicalCreditNoteEntity>();

  private transfersByKey = new Map<string, CanonicalStockTransferEntity>();
  private transfersById = new Map<string, CanonicalStockTransferEntity>();

  public reset(): void {
    this.invoicesByKey.clear();
    this.invoicesById.clear();
    this.creditNotesByKey.clear();
    this.creditNotesById.clear();
    this.transfersByKey.clear();
    this.transfersById.clear();
  }

  private validateTenant(ctx: TenantContext): void {
    if (!ctx || !ctx.organizationId) {
      throw new TenantAuthorizationError('Tenant context is missing or invalid.');
    }
  }

  public async getOrCreateCanonicalInvoice(
    ctx: TenantContext,
    input: CreateCanonicalInvoiceInput
  ): Promise<CanonicalInvoiceResult> {
    this.validateTenant(ctx);
    const key = `${ctx.organizationId}#${input.sellerGstin}#${input.financialYear}#${input.invoiceNumber}`;
    const existing = this.invoicesByKey.get(key);
    if (existing) {
      const conflicts = this.checkInvoiceConflicts(existing, input);
      return {
        invoice: existing,
        isNew: false,
        hasConflict: conflicts.length > 0,
        conflictDetails: conflicts
      };
    }

    const entity: CanonicalInvoiceEntity = {
      id: input.id || crypto.randomUUID(),
      organizationId: ctx.organizationId,
      sellerGstin: input.sellerGstin,
      financialYear: input.financialYear,
      invoiceNumber: input.invoiceNumber,
      invoiceDate: input.invoiceDate,
      orderId: input.orderId,
      recipientType: input.recipientType,
      customerGstin: input.customerGstin || null,
      shipFromStateCode: input.shipFromStateCode,
      placeOfSupplyStateCode: input.placeOfSupplyStateCode,
      supplyType: input.supplyType,
      currency: input.currency || 'INR',
      hasLegalHold: input.hasLegalHold || false,
      legalProceedingReference: input.legalProceedingReference || null,
      createdAt: new Date()
    };

    this.invoicesByKey.set(key, entity);
    this.invoicesById.set(`${ctx.organizationId}#${entity.id}`, entity);
    return {
      invoice: entity,
      isNew: true,
      hasConflict: false,
      conflictDetails: []
    };
  }

  public async findCanonicalInvoice(
    ctx: TenantContext,
    sellerGstin: string,
    financialYear: string,
    invoiceNumber: string
  ): Promise<CanonicalInvoiceEntity | null> {
    this.validateTenant(ctx);
    const key = `${ctx.organizationId}#${sellerGstin}#${financialYear}#${invoiceNumber}`;
    return this.invoicesByKey.get(key) || null;
  }

  public async findCanonicalInvoiceById(
    ctx: TenantContext,
    id: string
  ): Promise<CanonicalInvoiceEntity | null> {
    this.validateTenant(ctx);
    return this.invoicesById.get(`${ctx.organizationId}#${id}`) || null;
  }

  public async getOrCreateCanonicalCreditNote(
    ctx: TenantContext,
    input: CreateCanonicalCreditNoteInput
  ): Promise<CanonicalCreditNoteResult> {
    this.validateTenant(ctx);
    const key = `${ctx.organizationId}#${input.sellerGstin}#${input.financialYear}#${input.creditNoteNumber}`;
    const existing = this.creditNotesByKey.get(key);
    if (existing) {
      const conflicts = this.checkCreditNoteConflicts(existing, input);
      return {
        creditNote: existing,
        isNew: false,
        hasConflict: conflicts.length > 0,
        conflictDetails: conflicts
      };
    }

    const entity: CanonicalCreditNoteEntity = {
      id: input.id || crypto.randomUUID(),
      organizationId: ctx.organizationId,
      sellerGstin: input.sellerGstin,
      financialYear: input.financialYear,
      creditNoteNumber: input.creditNoteNumber,
      creditNoteDate: input.creditNoteDate,
      originalInvoiceNumber: input.originalInvoiceNumber || null,
      originalInvoiceDate: input.originalInvoiceDate || null,
      orderId: input.orderId || null,
      recipientType: input.recipientType,
      customerGstin: input.customerGstin || null,
      placeOfSupplyStateCode: input.placeOfSupplyStateCode || null,
      hasLegalHold: input.hasLegalHold || false,
      createdAt: new Date()
    };

    this.creditNotesByKey.set(key, entity);
    this.creditNotesById.set(`${ctx.organizationId}#${entity.id}`, entity);
    return {
      creditNote: entity,
      isNew: true,
      hasConflict: false,
      conflictDetails: []
    };
  }

  public async findCanonicalCreditNote(
    ctx: TenantContext,
    sellerGstin: string,
    financialYear: string,
    creditNoteNumber: string
  ): Promise<CanonicalCreditNoteEntity | null> {
    this.validateTenant(ctx);
    const key = `${ctx.organizationId}#${sellerGstin}#${financialYear}#${creditNoteNumber}`;
    return this.creditNotesByKey.get(key) || null;
  }

  public async findCanonicalCreditNoteById(
    ctx: TenantContext,
    id: string
  ): Promise<CanonicalCreditNoteEntity | null> {
    this.validateTenant(ctx);
    return this.creditNotesById.get(`${ctx.organizationId}#${id}`) || null;
  }

  public async getOrCreateCanonicalStockTransfer(
    ctx: TenantContext,
    input: CreateCanonicalStockTransferInput
  ): Promise<CanonicalStockTransferResult> {
    this.validateTenant(ctx);
    const key = `${ctx.organizationId}#${input.sourceGstin}#${input.financialYear}#${input.transferInvoiceNumber}`;
    const existing = this.transfersByKey.get(key);
    if (existing) {
      const conflicts = this.checkStockTransferConflicts(existing, input);
      return {
        transfer: existing,
        isNew: false,
        hasConflict: conflicts.length > 0,
        conflictDetails: conflicts
      };
    }

    const entity: CanonicalStockTransferEntity = {
      id: input.id || crypto.randomUUID(),
      organizationId: ctx.organizationId,
      sourceGstin: input.sourceGstin,
      financialYear: input.financialYear,
      transferInvoiceNumber: input.transferInvoiceNumber,
      transferDate: input.transferDate,
      destinationGstin: input.destinationGstin,
      sourcePan: input.sourcePan,
      destinationPan: input.destinationPan,
      shipFromStateCode: input.shipFromStateCode,
      shipToStateCode: input.shipToStateCode,
      hasLegalHold: input.hasLegalHold || false,
      createdAt: new Date()
    };

    this.transfersByKey.set(key, entity);
    this.transfersById.set(`${ctx.organizationId}#${entity.id}`, entity);
    return {
      transfer: entity,
      isNew: true,
      hasConflict: false,
      conflictDetails: []
    };
  }

  public async findCanonicalStockTransfer(
    ctx: TenantContext,
    sourceGstin: string,
    financialYear: string,
    transferInvoiceNumber: string
  ): Promise<CanonicalStockTransferEntity | null> {
    this.validateTenant(ctx);
    const key = `${ctx.organizationId}#${sourceGstin}#${financialYear}#${transferInvoiceNumber}`;
    return this.transfersByKey.get(key) || null;
  }

  public async findCanonicalStockTransferById(
    ctx: TenantContext,
    id: string
  ): Promise<CanonicalStockTransferEntity | null> {
    this.validateTenant(ctx);
    return this.transfersById.get(`${ctx.organizationId}#${id}`) || null;
  }

  private checkInvoiceConflicts(
    existing: CanonicalInvoiceEntity,
    incoming: CreateCanonicalInvoiceInput
  ): DocumentConflictDetail[] {
    const conflicts: DocumentConflictDetail[] = [];

    const exBuyer = existing.customerGstin || null;
    const inBuyer = incoming.customerGstin || null;
    if (exBuyer !== inBuyer) {
      conflicts.push({
        field: 'customerGstin',
        conflictType: 'BUYER_GSTIN_MISMATCH',
        existingValue: exBuyer,
        incomingValue: inBuyer,
        message: `Existing invoice '${existing.invoiceNumber}' has customer GSTIN '${exBuyer}', incoming record has '${inBuyer}'.`
      });
    }

    const exDate = toDateStr(existing.invoiceDate);
    const inDate = toDateStr(incoming.invoiceDate);
    if (exDate !== inDate) {
      conflicts.push({
        field: 'invoiceDate',
        conflictType: 'INVOICE_DATE_MISMATCH',
        existingValue: exDate,
        incomingValue: inDate,
        message: `Existing invoice '${existing.invoiceNumber}' has date '${exDate}', incoming record has '${inDate}'.`
      });
    }

    if (existing.recipientType !== incoming.recipientType) {
      conflicts.push({
        field: 'recipientType',
        conflictType: 'DOCUMENT_TYPE_MISMATCH',
        existingValue: existing.recipientType,
        incomingValue: incoming.recipientType,
        message: `Existing invoice '${existing.invoiceNumber}' has recipient type '${existing.recipientType}', incoming record has '${incoming.recipientType}'.`
      });
    }

    if (existing.placeOfSupplyStateCode !== incoming.placeOfSupplyStateCode) {
      conflicts.push({
        field: 'placeOfSupplyStateCode',
        conflictType: 'PLACE_OF_SUPPLY_MISMATCH',
        existingValue: existing.placeOfSupplyStateCode,
        incomingValue: incoming.placeOfSupplyStateCode,
        message: `Existing invoice '${existing.invoiceNumber}' has place of supply '${existing.placeOfSupplyStateCode}', incoming record has '${incoming.placeOfSupplyStateCode}'.`
      });
    }

    return conflicts;
  }

  private checkCreditNoteConflicts(
    existing: CanonicalCreditNoteEntity,
    incoming: CreateCanonicalCreditNoteInput
  ): DocumentConflictDetail[] {
    const conflicts: DocumentConflictDetail[] = [];

    const exDate = toDateStr(existing.creditNoteDate);
    const inDate = toDateStr(incoming.creditNoteDate);
    if (exDate !== inDate) {
      conflicts.push({
        field: 'creditNoteDate',
        conflictType: 'CREDIT_NOTE_DATE_MISMATCH',
        existingValue: exDate,
        incomingValue: inDate,
        message: `Existing credit note '${existing.creditNoteNumber}' has date '${exDate}', incoming record has '${inDate}'.`
      });
    }

    const exOrig = existing.originalInvoiceNumber || null;
    const inOrig = incoming.originalInvoiceNumber || null;
    if (exOrig !== inOrig) {
      conflicts.push({
        field: 'originalInvoiceNumber',
        conflictType: 'ORIGINAL_INVOICE_NUMBER_MISMATCH',
        existingValue: exOrig,
        incomingValue: inOrig,
        message: `Existing credit note '${existing.creditNoteNumber}' references invoice '${exOrig}', incoming references '${inOrig}'.`
      });
    }

    if (existing.recipientType !== incoming.recipientType) {
      conflicts.push({
        field: 'recipientType',
        conflictType: 'DOCUMENT_TYPE_MISMATCH',
        existingValue: existing.recipientType,
        incomingValue: incoming.recipientType,
        message: `Existing credit note has recipient type '${existing.recipientType}', incoming has '${incoming.recipientType}'.`
      });
    }

    return conflicts;
  }

  private checkStockTransferConflicts(
    existing: CanonicalStockTransferEntity,
    incoming: CreateCanonicalStockTransferInput
  ): DocumentConflictDetail[] {
    const conflicts: DocumentConflictDetail[] = [];

    const exDate = toDateStr(existing.transferDate);
    const inDate = toDateStr(incoming.transferDate);
    if (exDate !== inDate) {
      conflicts.push({
        field: 'transferDate',
        conflictType: 'TRANSFER_DATE_MISMATCH',
        existingValue: exDate,
        incomingValue: inDate,
        message: `Existing transfer '${existing.transferInvoiceNumber}' has date '${exDate}', incoming record has '${inDate}'.`
      });
    }

    if (existing.destinationGstin !== incoming.destinationGstin) {
      conflicts.push({
        field: 'destinationGstin',
        conflictType: 'DESTINATION_GSTIN_MISMATCH',
        existingValue: existing.destinationGstin,
        incomingValue: incoming.destinationGstin,
        message: `Existing transfer has destination GSTIN '${existing.destinationGstin}', incoming has '${incoming.destinationGstin}'.`
      });
    }

    return conflicts;
  }
}
