import Decimal from 'decimal.js';

// Configure Decimal globally for deterministic financial arithmetic
// ROUND_HALF_UP (4) is standard for statutory Indian GST rounding (nearest rupee or 2 decimal places)
Decimal.set({
  precision: 20,
  rounding: Decimal.ROUND_HALF_UP
});

export { Decimal };

export function toDecimal(val: string | number | Decimal | null | undefined): Decimal {
  if (val === null || val === undefined || val === '') {
    return new Decimal(0);
  }
  return new Decimal(val);
}

export function roundToTwo(val: Decimal): Decimal {
  return val.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/**
 * Section 170 of CGST Act: Rounding off to the nearest rupee.
 * If fractional paise is 50 paise or more, increase to 1 rupee; if less than 50 paise, ignore.
 */
export function roundToNearestRupee(val: Decimal): Decimal {
  return val.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
}

export function formatCurrency(val: Decimal): string {
  return roundToTwo(val).toFixed(2);
}
