import crypto from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
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
  DocumentConflictDetail
} from '../types.js';
import { runInTenantTransaction } from './tenant-context.js';

function toDateStr(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return new Date(d).toISOString().slice(0, 10);
}

export class PrismaCanonicalDocumentRepository implements ICanonicalDocumentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public async getOrCreateCanonicalInvoice(
    ctx: TenantContext,
    input: CreateCanonicalInvoiceInput,
    tx?: Prisma.TransactionClient
  ): Promise<CanonicalInvoiceResult> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        // 1. Check if already exists
        const existing = await client.canonicalInvoice.findFirst({
          where: {
            organizationId: ctx.organizationId,
            sellerGstin: input.sellerGstin,
            financialYear: input.financialYear,
            invoiceNumber: input.invoiceNumber
          }
        });

        if (existing) {
          const conflicts = this.checkInvoiceConflicts(existing, input);
          return {
            invoice: this.mapInvoice(existing),
            isNew: false,
            hasConflict: conflicts.length > 0,
            conflictDetails: conflicts
          };
        }

        // 2. Insert new canonical invoice
        try {
          const created = await client.canonicalInvoice.create({
            data: {
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
              legalProceedingReference: input.legalProceedingReference || null
            }
          });
          return {
            invoice: this.mapInvoice(created),
            isNew: true,
            hasConflict: false,
            conflictDetails: []
          };
        } catch (error: any) {
          // Concurrent race condition handling (P2002)
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
          ) {
            const recheck = await this.prisma.canonicalInvoice.findFirst({
              where: {
                organizationId: ctx.organizationId,
                sellerGstin: input.sellerGstin,
                financialYear: input.financialYear,
                invoiceNumber: input.invoiceNumber
              }
            });
            if (recheck) {
              const conflicts = this.checkInvoiceConflicts(recheck, input);
              return {
                invoice: this.mapInvoice(recheck),
                isNew: false,
                hasConflict: conflicts.length > 0,
                conflictDetails: conflicts
              };
            }
          }
          throw error;
        }
      },
      tx
    );
  }

  public async findCanonicalInvoice(
    ctx: TenantContext,
    sellerGstin: string,
    financialYear: string,
    invoiceNumber: string,
    tx?: Prisma.TransactionClient
  ): Promise<CanonicalInvoiceEntity | null> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const row = await client.canonicalInvoice.findFirst({
          where: {
            organizationId: ctx.organizationId,
            sellerGstin,
            financialYear,
            invoiceNumber
          }
        });
        return row ? this.mapInvoice(row) : null;
      },
      tx
    );
  }

  public async findCanonicalInvoiceById(
    ctx: TenantContext,
    id: string,
    tx?: Prisma.TransactionClient
  ): Promise<CanonicalInvoiceEntity | null> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const row = await client.canonicalInvoice.findFirst({
          where: {
            organizationId: ctx.organizationId,
            id
          }
        });
        return row ? this.mapInvoice(row) : null;
      },
      tx
    );
  }

  public async getOrCreateCanonicalCreditNote(
    ctx: TenantContext,
    input: CreateCanonicalCreditNoteInput,
    tx?: Prisma.TransactionClient
  ): Promise<CanonicalCreditNoteResult> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const existing = await client.canonicalCreditNote.findFirst({
          where: {
            organizationId: ctx.organizationId,
            sellerGstin: input.sellerGstin,
            financialYear: input.financialYear,
            creditNoteNumber: input.creditNoteNumber
          }
        });

        if (existing) {
          const conflicts = this.checkCreditNoteConflicts(existing, input);
          return {
            creditNote: this.mapCreditNote(existing),
            isNew: false,
            hasConflict: conflicts.length > 0,
            conflictDetails: conflicts
          };
        }

        try {
          const created = await client.canonicalCreditNote.create({
            data: {
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
              hasLegalHold: input.hasLegalHold || false
            }
          });
          return {
            creditNote: this.mapCreditNote(created),
            isNew: true,
            hasConflict: false,
            conflictDetails: []
          };
        } catch (error: any) {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
          ) {
            const recheck = await this.prisma.canonicalCreditNote.findFirst({
              where: {
                organizationId: ctx.organizationId,
                sellerGstin: input.sellerGstin,
                financialYear: input.financialYear,
                creditNoteNumber: input.creditNoteNumber
              }
            });
            if (recheck) {
              const conflicts = this.checkCreditNoteConflicts(recheck, input);
              return {
                creditNote: this.mapCreditNote(recheck),
                isNew: false,
                hasConflict: conflicts.length > 0,
                conflictDetails: conflicts
              };
            }
          }
          throw error;
        }
      },
      tx
    );
  }

  public async findCanonicalCreditNote(
    ctx: TenantContext,
    sellerGstin: string,
    financialYear: string,
    creditNoteNumber: string,
    tx?: Prisma.TransactionClient
  ): Promise<CanonicalCreditNoteEntity | null> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const row = await client.canonicalCreditNote.findFirst({
          where: {
            organizationId: ctx.organizationId,
            sellerGstin,
            financialYear,
            creditNoteNumber
          }
        });
        return row ? this.mapCreditNote(row) : null;
      },
      tx
    );
  }

  public async findCanonicalCreditNoteById(
    ctx: TenantContext,
    id: string,
    tx?: Prisma.TransactionClient
  ): Promise<CanonicalCreditNoteEntity | null> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const row = await client.canonicalCreditNote.findFirst({
          where: {
            organizationId: ctx.organizationId,
            id
          }
        });
        return row ? this.mapCreditNote(row) : null;
      },
      tx
    );
  }

  public async getOrCreateCanonicalStockTransfer(
    ctx: TenantContext,
    input: CreateCanonicalStockTransferInput,
    tx?: Prisma.TransactionClient
  ): Promise<CanonicalStockTransferResult> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const existing = await client.canonicalStockTransfer.findFirst({
          where: {
            organizationId: ctx.organizationId,
            sourceGstin: input.sourceGstin,
            financialYear: input.financialYear,
            transferInvoiceNumber: input.transferInvoiceNumber
          }
        });

        if (existing) {
          const conflicts = this.checkStockTransferConflicts(existing, input);
          return {
            transfer: this.mapTransfer(existing),
            isNew: false,
            hasConflict: conflicts.length > 0,
            conflictDetails: conflicts
          };
        }

        try {
          const created = await client.canonicalStockTransfer.create({
            data: {
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
              hasLegalHold: input.hasLegalHold || false
            }
          });
          return {
            transfer: this.mapTransfer(created),
            isNew: true,
            hasConflict: false,
            conflictDetails: []
          };
        } catch (error: any) {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
          ) {
            const recheck = await this.prisma.canonicalStockTransfer.findFirst({
              where: {
                organizationId: ctx.organizationId,
                sourceGstin: input.sourceGstin,
                financialYear: input.financialYear,
                transferInvoiceNumber: input.transferInvoiceNumber
              }
            });
            if (recheck) {
              const conflicts = this.checkStockTransferConflicts(recheck, input);
              return {
                transfer: this.mapTransfer(recheck),
                isNew: false,
                hasConflict: conflicts.length > 0,
                conflictDetails: conflicts
              };
            }
          }
          throw error;
        }
      },
      tx
    );
  }

  public async findCanonicalStockTransfer(
    ctx: TenantContext,
    sourceGstin: string,
    financialYear: string,
    transferInvoiceNumber: string,
    tx?: Prisma.TransactionClient
  ): Promise<CanonicalStockTransferEntity | null> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const row = await client.canonicalStockTransfer.findFirst({
          where: {
            organizationId: ctx.organizationId,
            sourceGstin,
            financialYear,
            transferInvoiceNumber
          }
        });
        return row ? this.mapTransfer(row) : null;
      },
      tx
    );
  }

  public async findCanonicalStockTransferById(
    ctx: TenantContext,
    id: string,
    tx?: Prisma.TransactionClient
  ): Promise<CanonicalStockTransferEntity | null> {
    return runInTenantTransaction(
      this.prisma,
      ctx,
      async (client) => {
        const row = await client.canonicalStockTransfer.findFirst({
          where: {
            organizationId: ctx.organizationId,
            id
          }
        });
        return row ? this.mapTransfer(row) : null;
      },
      tx
    );
  }

  // ==========================================
  // CONFLICT CHECKERS
  // ==========================================

  private checkInvoiceConflicts(
    existing: any,
    incoming: CreateCanonicalInvoiceInput
  ): DocumentConflictDetail[] {
    const conflicts: DocumentConflictDetail[] = [];

    // 1. Buyer GSTIN
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

    // 2. Invoice Date
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

    // 3. Document / Recipient Type
    if (existing.recipientType !== incoming.recipientType) {
      conflicts.push({
        field: 'recipientType',
        conflictType: 'DOCUMENT_TYPE_MISMATCH',
        existingValue: existing.recipientType,
        incomingValue: incoming.recipientType,
        message: `Existing invoice '${existing.invoiceNumber}' has recipient type '${existing.recipientType}', incoming record has '${incoming.recipientType}'.`
      });
    }

    // 4. Place of supply
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
    existing: any,
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
    existing: any,
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

  private mapInvoice(row: any): CanonicalInvoiceEntity {
    return {
      id: row.id,
      organizationId: row.organizationId,
      sellerGstin: row.sellerGstin,
      financialYear: row.financialYear,
      invoiceNumber: row.invoiceNumber,
      invoiceDate: row.invoiceDate,
      orderId: row.orderId,
      recipientType: row.recipientType,
      customerGstin: row.customerGstin,
      shipFromStateCode: row.shipFromStateCode,
      placeOfSupplyStateCode: row.placeOfSupplyStateCode,
      supplyType: row.supplyType,
      currency: row.currency,
      hasLegalHold: row.hasLegalHold,
      legalProceedingReference: row.legalProceedingReference,
      createdAt: row.createdAt
    };
  }

  private mapCreditNote(row: any): CanonicalCreditNoteEntity {
    return {
      id: row.id,
      organizationId: row.organizationId,
      sellerGstin: row.sellerGstin,
      financialYear: row.financialYear,
      creditNoteNumber: row.creditNoteNumber,
      creditNoteDate: row.creditNoteDate,
      originalInvoiceNumber: row.originalInvoiceNumber,
      originalInvoiceDate: row.originalInvoiceDate,
      orderId: row.orderId,
      recipientType: row.recipientType,
      customerGstin: row.customerGstin,
      placeOfSupplyStateCode: row.placeOfSupplyStateCode,
      hasLegalHold: row.hasLegalHold,
      createdAt: row.createdAt
    };
  }

  private mapTransfer(row: any): CanonicalStockTransferEntity {
    return {
      id: row.id,
      organizationId: row.organizationId,
      sourceGstin: row.sourceGstin,
      financialYear: row.financialYear,
      transferInvoiceNumber: row.transferInvoiceNumber,
      transferDate: row.transferDate,
      destinationGstin: row.destinationGstin,
      sourcePan: row.sourcePan,
      destinationPan: row.destinationPan,
      shipFromStateCode: row.shipFromStateCode,
      shipToStateCode: row.shipToStateCode,
      hasLegalHold: row.hasLegalHold,
      createdAt: row.createdAt
    };
  }
}
