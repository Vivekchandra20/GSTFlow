import { Decimal, roundToTwo, roundToNearestRupee, toDecimal } from '../utils/decimal.js';
import { SupplyType } from '../models/enums.js';
import { isUTGSTApplicable } from '../utils/state-codes.js';
import { TaxBreakdown } from '../models/transaction.schema.js';

export type InvoiceRoundingPolicy = 'EXACT_TWO_DECIMALS' | 'NEAREST_RUPEE';

export interface CalculationPolicy {
  includeShippingInTaxableBase: boolean;
  roundingTolerance: Decimal;
  invoiceRoundingPolicy?: InvoiceRoundingPolicy; // Section 170 nearest rupee vs exact 2-decimals
}

export const DEFAULT_CALCULATION_POLICY: CalculationPolicy = {
  includeShippingInTaxableBase: true,
  roundingTolerance: new Decimal('0.02'), // Accommodates standard 2-decimal statutory rounding variances
  invoiceRoundingPolicy: 'EXACT_TWO_DECIMALS'
};

export interface TaxCalculationParams {
  taxableValue: Decimal;
  shippingTaxableValue?: Decimal;
  taxRate: Decimal;
  supplyType: SupplyType;
  shipFromStateCode: string;
  placeOfSupplyStateCode: string;
  cessRate?: Decimal;
  cessSpecific?: Decimal;
  cessBasis?: Decimal; // Customizable cess taxable basis
}

export class GSTCalculator {
  /**
   * Deterministically calculates expected GST tax breakdown components using ROUND_HALF_UP.
   */
  public static calculateTax(
    params: TaxCalculationParams,
    policy: CalculationPolicy = DEFAULT_CALCULATION_POLICY
  ): TaxBreakdown {
    const taxableValue = roundToTwo(params.taxableValue);
    const shippingTaxableValue = roundToTwo(params.shippingTaxableValue || new Decimal(0));

    // Determine taxable base according to configured policy
    const totalTaxableValue = policy.includeShippingInTaxableBase
      ? taxableValue.add(shippingTaxableValue)
      : taxableValue;

    const taxRate = params.taxRate;
    let cgstRate = new Decimal(0);
    let cgstAmount = new Decimal(0);
    let sgstRate = new Decimal(0);
    let sgstAmount = new Decimal(0);
    let utgstRate = new Decimal(0);
    let utgstAmount = new Decimal(0);
    let igstRate = new Decimal(0);
    let igstAmount = new Decimal(0);

    if (params.supplyType === SupplyType.INTRASTATE) {
      const halfRate = taxRate.div(new Decimal(2));
      cgstRate = halfRate;
      cgstAmount = roundToTwo(totalTaxableValue.mul(cgstRate).div(new Decimal(100)));

      if (isUTGSTApplicable(params.shipFromStateCode)) {
        utgstRate = halfRate;
        utgstAmount = roundToTwo(totalTaxableValue.mul(utgstRate).div(new Decimal(100)));
      } else {
        sgstRate = halfRate;
        sgstAmount = roundToTwo(totalTaxableValue.mul(sgstRate).div(new Decimal(100)));
      }
    } else if (params.supplyType === SupplyType.INTERSTATE) {
      igstRate = taxRate;
      igstAmount = roundToTwo(totalTaxableValue.mul(igstRate).div(new Decimal(100)));
    }

    // Cess calculation with independent basis support
    let cessAmount = new Decimal(0);
    if (params.cessRate && params.cessRate.gt(0)) {
      const cessBase = params.cessBasis !== undefined ? params.cessBasis : totalTaxableValue;
      cessAmount = cessAmount.add(roundToTwo(cessBase.mul(params.cessRate).div(new Decimal(100))));
    }
    if (params.cessSpecific && params.cessSpecific.gt(0)) {
      cessAmount = cessAmount.add(roundToTwo(params.cessSpecific));
    }

    const exactTotal = totalTaxableValue
      .add(cgstAmount)
      .add(sgstAmount)
      .add(utgstAmount)
      .add(igstAmount)
      .add(cessAmount);

    // Apply Section 170 nearest rupee rounding if configured, while line components retain 2-decimal precision
    const totalInvoiceAmount =
      policy.invoiceRoundingPolicy === 'NEAREST_RUPEE'
        ? roundToNearestRupee(exactTotal)
        : roundToTwo(exactTotal);

    return {
      taxableValue,
      shippingTaxableValue,
      totalTaxableValue,
      taxRate,
      cgstRate,
      cgstAmount,
      sgstRate,
      sgstAmount,
      utgstRate,
      utgstAmount,
      igstRate,
      igstAmount,
      cessAmount,
      totalInvoiceAmount
    };
  }

  /**
   * Validates whether a declared tax component matches calculated value within tolerance.
   */
  public static isWithinTolerance(
    declared: Decimal,
    expected: Decimal,
    tolerance: Decimal = DEFAULT_CALCULATION_POLICY.roundingTolerance
  ): boolean {
    return declared.sub(expected).abs().lte(tolerance);
  }
}
