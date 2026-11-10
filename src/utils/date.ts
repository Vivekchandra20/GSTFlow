/**
 * Parse an ISO date string (YYYY-MM-DD) strictly at UTC midnight to avoid local timezone offset drift.
 * Returns null if the format is invalid or represents an impossible calendar date.
 */
export function parseISODateStrict(dateStr: string | null | undefined): Date | null {
  if (!dateStr || typeof dateStr !== 'string') {
    return null;
  }
  const trimmed = dateStr.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) {
    return null;
  }

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  // Verify month length (leap year check for Feb, 30 days for Apr, Jun, Sep, Nov)
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) {
    return null;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  return isNaN(date.getTime()) ? null : date;
}

/**
 * Returns Indian Financial Year string (e.g., '2026-2027').
 * Financial Year begins April 1st and ends March 31st of the following calendar year.
 */
export function getFinancialYear(date: Date): string {
  const month = date.getUTCMonth() + 1; // 1-12
  const year = date.getUTCFullYear();

  if (month >= 4) {
    return `${year}-${year + 1}`;
  } else {
    return `${year - 1}-${year}`;
  }
}

/**
 * Returns compact Indian Financial Year string (e.g., '26-27')
 */
export function getShortFinancialYear(date: Date): string {
  const month = date.getUTCMonth() + 1;
  const year = date.getUTCFullYear();
  const startYr = month >= 4 ? year : year - 1;
  const endYr = startYr + 1;
  return `${String(startYr).slice(-2)}-${String(endYr).slice(-2)}`;
}
