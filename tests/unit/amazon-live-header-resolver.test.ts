import { describe, it, expect } from 'vitest';
import {
  HeaderAliasResolver,
  TIER1_VERIFIED_ALIASES,
  MANDATORY_MTR_HEADERS
} from '../../src/adapters/amazon/amazon-live-header-resolver.js';
import {
  DuplicateCanonicalHeaderError,
  UnsupportedReportFormatError
} from '../../src/adapters/amazon/amazon-live.types.js';

describe('HeaderAliasResolver (Unit)', () => {
  it('maps standard official Amazon MTR headers positionally', () => {
    const resolver = new HeaderAliasResolver();
    const rawHeaders = [
      'Seller GSTIN',
      'Invoice Number',
      'Invoice Date',
      'Transaction Type',
      'Order ID',
      'Principal Amount Basis',
      'Customer Bill to GSTIN'
    ];

    const mapped = resolver.mapHeaderRow(rawHeaders);
    expect(mapped).toEqual([
      'sellerGstin',
      'invoiceNumber',
      'invoiceDate',
      'transactionType',
      'orderId',
      'principalAmountBasis',
      'customerBillToGstin'
    ]);
  });

  it('preserves unmapped headers positionally without crashing', () => {
    const resolver = new HeaderAliasResolver({
      mandatoryHeaders: ['sellerGstin', 'invoiceNumber', 'transactionType', 'invoiceDate', 'orderId']
    });
    const rawHeaders = [
      'Seller GSTIN',
      'Invoice Number',
      'Invoice Date',
      'Transaction Type',
      'Order ID',
      'Custom Unrecognized Header'
    ];

    const mapped = resolver.mapHeaderRow(rawHeaders);
    expect(mapped[5]).toBe('Custom Unrecognized Header');
  });

  it('matches headers case-insensitively and ignores punctuation/spaces', () => {
    const resolver = new HeaderAliasResolver();
    const rawHeaders = [
      'SELLER GSTIN',
      'invoice-number',
      'INVOICE DATE',
      'transaction_type',
      'order id',
      'customer bill-to gstin'
    ];

    const mapped = resolver.mapHeaderRow(rawHeaders);
    expect(mapped).toEqual([
      'sellerGstin',
      'invoiceNumber',
      'invoiceDate',
      'transactionType',
      'orderId',
      'customerBillToGstin'
    ]);
  });

  it('strips UTF-8 BOM from header tokens', () => {
    const resolver = new HeaderAliasResolver();
    const rawHeaders = [
      '\ufeffSeller GSTIN',
      'Invoice Number',
      'Invoice Date',
      'Transaction Type',
      'Order ID'
    ];

    const mapped = resolver.mapHeaderRow(rawHeaders);
    expect(mapped[0]).toBe('sellerGstin');
  });

  it('throws DuplicateCanonicalHeaderError when multiple headers map to the same canonical key', () => {
    const resolver = new HeaderAliasResolver();
    const duplicateHeaders = [
      'Seller GSTIN',
      'Invoice Number',
      'Invoice Date',
      'Transaction Type',
      'Order ID',
      'Customer Bill to GSTIN',
      'Buyer GSTIN' // Both map to customerBillToGstin
    ];

    expect(() => resolver.mapHeaderRow(duplicateHeaders)).toThrowError(DuplicateCanonicalHeaderError);
  });

  it('throws UnsupportedReportFormatError when mandatory headers are missing', () => {
    const resolver = new HeaderAliasResolver();
    const missingHeaders = [
      'Order ID',
      'Principal Amount Basis',
      'Invoice Amount'
    ];

    expect(() => resolver.mapHeaderRow(missingHeaders)).toThrowError(UnsupportedReportFormatError);
  });

  it('disables Tier 3 unverified aliases by default', () => {
    const resolverDefault = new HeaderAliasResolver({ enableTier3Unverified: false });
    // 'OrderItemId' is a Tier 3 unverified alias for shipmentItemId
    expect(resolverDefault.resolve('OrderItemId')).toBeUndefined();

    const resolverTier3 = new HeaderAliasResolver({ enableTier3Unverified: true });
    expect(resolverTier3.resolve('OrderItemId')).toBe('shipmentItemId');
  });

  it('applies custom caller overrides with highest priority', () => {
    const resolver = new HeaderAliasResolver({
      customOverrides: {
        sellerGstin: ['MyCustomMerchantTaxId']
      }
    });

    expect(resolver.resolve('MyCustomMerchantTaxId')).toBe('sellerGstin');
  });
});
