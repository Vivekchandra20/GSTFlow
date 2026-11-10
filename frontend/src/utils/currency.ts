/**
 * Formats a numeric or string value according to the Indian numbering system.
 * e.g. 125000 -> ₹1,25,000.00
 *      1250000 -> ₹12,50,000.00
 *      12345678 -> ₹1,23,45,678.00
 */
export function formatInr(
  value: number | string | null | undefined,
  options: {
    showSymbol?: boolean;
    showDecimals?: boolean;
    compact?: boolean;
  } = {}
): string {
  const { showSymbol = true, showDecimals = true, compact = false } = options;

  if (value === null || value === undefined || value === '') {
    return showSymbol ? '₹0.00' : '0.00';
  }

  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) {
    return showSymbol ? '₹0.00' : '0.00';
  }

  if (compact && Math.abs(num) >= 10000000) {
    const crores = num / 10000000;
    return `${showSymbol ? '₹' : ''}${crores.toFixed(2)} Cr`;
  }
  if (compact && Math.abs(num) >= 100000) {
    const lakhs = num / 100000;
    return `${showSymbol ? '₹' : ''}${lakhs.toFixed(2)} L`;
  }

  const isNegative = num < 0;
  const absNum = Math.abs(num);

  const parts = absNum.toFixed(showDecimals ? 2 : 0).split('.');
  let integerPart = parts[0];
  const decimalPart = parts[1];

  // Indian grouping: last 3 digits, then groups of 2
  if (integerPart.length > 3) {
    const lastThree = integerPart.substring(integerPart.length - 3);
    const remaining = integerPart.substring(0, integerPart.length - 3);
    const grouped = remaining.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    integerPart = `${grouped},${lastThree}`;
  }

  const formattedNumber = showDecimals && decimalPart ? `${integerPart}.${decimalPart}` : integerPart;
  const sign = isNegative ? '-' : '';
  const symbol = showSymbol ? '₹' : '';

  return `${sign}${symbol}${formattedNumber}`;
}
