import { describe, it, expect } from 'vitest';
import { Decimal } from '../../src/utils/decimal.js';
import { GSTCalculator } from '../../src/engine/gst-calculator.js';
import { SupplyType } from '../../src/models/enums.js';

describe('GSTCalculator - Precision & Rounding Tests', () => {
  it('applies strict ROUND_HALF_UP on tax calculations independently verified', () => {
    // Independent manual math:
    // Taxable: 100.55, Rate: 5% (Intrastate -> CGST 2.5%, SGST 2.5%)
    // CGST: 100.55 * 0.025 = 2.51375 -> rounded half up = 2.51
    // SGST: 100.55 * 0.025 = 2.51375 -> rounded half up = 2.51
    // Total Invoice: 100.55 + 2.51 + 2.51 = 105.57
    const result = GSTCalculator.calculateTax({
      taxableValue: new Decimal('100.55'),
      taxRate: new Decimal('5'),
      supplyType: SupplyType.INTRASTATE,
      shipFromStateCode: '27', // Maharashtra (State)
      placeOfSupplyStateCode: '27'
    });

    expect(result.cgstAmount.toString()).toBe('2.51');
    expect(result.sgstAmount.toString()).toBe('2.51');
    expect(result.utgstAmount.toString()).toBe('0');
    expect(result.igstAmount.toString()).toBe('0');
    expect(result.totalInvoiceAmount.toString()).toBe('105.57');
  });

  it('correctly rounds .005 up in interstate calculations', () => {
    // Independent manual math:
    // Taxable: 15.00, Rate: 5%
    // 15.00 * 0.05 = 0.75 -> 0.75
    // Taxable: 13.50, Rate: 5% -> 13.50 * 0.05 = 0.675 -> rounded half up = 0.68
    const result = GSTCalculator.calculateTax({
      taxableValue: new Decimal('13.50'),
      taxRate: new Decimal('5'),
      supplyType: SupplyType.INTERSTATE,
      shipFromStateCode: '27',
      placeOfSupplyStateCode: '09'
    });

    expect(result.igstAmount.toString()).toBe('0.68');
    expect(result.totalInvoiceAmount.toString()).toBe('14.18');
  });
});

describe('GSTCalculator - Jurisdiction & Component Selection', () => {
  it('routes intrastate tax to CGST + UTGST for Union Territories without Legislature', () => {
    // Ship from Chandigarh (04) to Chandigarh (04)
    // Taxable: 1000.00, Rate: 18% -> CGST 90.00, UTGST 90.00, SGST 0.00
    const result = GSTCalculator.calculateTax({
      taxableValue: new Decimal('1000.00'),
      taxRate: new Decimal('18'),
      supplyType: SupplyType.INTRASTATE,
      shipFromStateCode: '04', // Chandigarh
      placeOfSupplyStateCode: '04'
    });

    expect(result.cgstAmount.toString()).toBe('90');
    expect(result.utgstAmount.toString()).toBe('90');
    expect(result.sgstAmount.toString()).toBe('0');
    expect(result.igstAmount.toString()).toBe('0');
    expect(result.totalInvoiceAmount.toString()).toBe('1180');
  });

  it('routes intrastate tax to CGST + SGST for Union Territories WITH Legislature', () => {
    // Delhi (07) has a legislature -> SGST applies, NOT UTGST
    const result = GSTCalculator.calculateTax({
      taxableValue: new Decimal('1000.00'),
      taxRate: new Decimal('18'),
      supplyType: SupplyType.INTRASTATE,
      shipFromStateCode: '07', // Delhi
      placeOfSupplyStateCode: '07'
    });

    expect(result.cgstAmount.toString()).toBe('90');
    expect(result.sgstAmount.toString()).toBe('90');
    expect(result.utgstAmount.toString()).toBe('0');
    expect(result.igstAmount.toString()).toBe('0');
  });

  it('routes interstate tax to IGST exclusively', () => {
    // Karnataka (29) to Maharashtra (27)
    // Taxable: 2000.00, Rate: 12% -> IGST 240.00, CGST/SGST/UTGST 0.00
    const result = GSTCalculator.calculateTax({
      taxableValue: new Decimal('2000.00'),
      taxRate: new Decimal('12'),
      supplyType: SupplyType.INTERSTATE,
      shipFromStateCode: '29',
      placeOfSupplyStateCode: '27'
    });

    expect(result.igstAmount.toString()).toBe('240');
    expect(result.cgstAmount.toString()).toBe('0');
    expect(result.sgstAmount.toString()).toBe('0');
    expect(result.utgstAmount.toString()).toBe('0');
    expect(result.totalInvoiceAmount.toString()).toBe('2240');
  });
});

describe('GSTCalculator - Configurable Shipping Taxable Base & Cess', () => {
  it('includes shipping taxable value when policy.includeShippingInTaxableBase is true', () => {
    // Product: 4865.56, Shipping: 134.89 -> Total base = 5000.45
    // IGST @ 18% = 5000.45 * 0.18 = 900.081 -> 900.08
    // Total Invoice = 5000.45 + 900.08 = 5900.53
    const result = GSTCalculator.calculateTax(
      {
        taxableValue: new Decimal('4865.56'),
        shippingTaxableValue: new Decimal('134.89'),
        taxRate: new Decimal('18'),
        supplyType: SupplyType.INTERSTATE,
        shipFromStateCode: '09',
        placeOfSupplyStateCode: '23'
      },
      { includeShippingInTaxableBase: true, roundingTolerance: new Decimal('0.02') }
    );

    expect(result.totalTaxableValue.toString()).toBe('5000.45');
    expect(result.igstAmount.toString()).toBe('900.08');
    expect(result.totalInvoiceAmount.toString()).toBe('5900.53');
  });

  it('excludes shipping taxable value when policy.includeShippingInTaxableBase is false', () => {
    // Product: 4865.56, Shipping: 134.89 (excluded from tax base)
    // Base = 4865.56
    // IGST @ 18% = 4865.56 * 0.18 = 875.8008 -> 875.80
    // Total Invoice = 4865.56 + 875.80 = 5741.36
    const result = GSTCalculator.calculateTax(
      {
        taxableValue: new Decimal('4865.56'),
        shippingTaxableValue: new Decimal('134.89'),
        taxRate: new Decimal('18'),
        supplyType: SupplyType.INTERSTATE,
        shipFromStateCode: '09',
        placeOfSupplyStateCode: '23'
      },
      { includeShippingInTaxableBase: false, roundingTolerance: new Decimal('0.02') }
    );

    expect(result.totalTaxableValue.toString()).toBe('4865.56');
    expect(result.igstAmount.toString()).toBe('875.8');
    expect(result.totalInvoiceAmount.toString()).toBe('5741.36');
  });

  it('calculates ad valorem and specific cess independently from tax base', () => {
    // Taxable: 10000.00, Tax Rate: 28% -> IGST: 2800.00
    // Ad valorem Cess: 15% on 10000.00 = 1500.00
    // Specific Cess: 50.00
    // Total Invoice: 10000 + 2800 + 1500 + 50 = 14350.00
    const result = GSTCalculator.calculateTax({
      taxableValue: new Decimal('10000.00'),
      taxRate: new Decimal('28'),
      supplyType: SupplyType.INTERSTATE,
      shipFromStateCode: '27',
      placeOfSupplyStateCode: '09',
      cessRate: new Decimal('15'),
      cessSpecific: new Decimal('50')
    });

    expect(result.igstAmount.toString()).toBe('2800');
    expect(result.cessAmount.toString()).toBe('1550');
    expect(result.totalInvoiceAmount.toString()).toBe('14350');
  });
});
