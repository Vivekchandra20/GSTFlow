import { describe, it, expect } from 'vitest';
import { Decimal, roundToTwo, toDecimal, formatCurrency } from '../../src/utils/decimal.js';
import { parseISODateStrict, getFinancialYear, getShortFinancialYear } from '../../src/utils/date.js';
import {
  isValidStateCode,
  isUTGSTApplicable,
  isValidGSTINStructure,
  extractPANFromGSTIN,
  getJurisdictionCategory,
  JurisdictionCategory
} from '../../src/utils/state-codes.js';
import { maskGSTIN } from '../../src/utils/logger.js';

describe('Decimal Utilities', () => {
  it('strictly enforces ROUND_HALF_UP rounding', () => {
    expect(roundToTwo(new Decimal('10.555')).toString()).toBe('10.56');
    expect(roundToTwo(new Decimal('10.554')).toString()).toBe('10.55');
    expect(roundToTwo(new Decimal('10.5550')).toString()).toBe('10.56');
    expect(roundToTwo(new Decimal('2.675')).toString()).toBe('2.68');
  });

  it('handles null, undefined, and empty string gracefully with toDecimal', () => {
    expect(toDecimal(null).toString()).toBe('0');
    expect(toDecimal(undefined).toString()).toBe('0');
    expect(toDecimal('').toString()).toBe('0');
    expect(toDecimal('123.45').toString()).toBe('123.45');
  });

  it('formats currency correctly to 2 decimal places', () => {
    expect(formatCurrency(new Decimal('123.4'))).toBe('123.40');
    expect(formatCurrency(new Decimal('123'))).toBe('123.00');
    expect(formatCurrency(new Decimal('123.456'))).toBe('123.46');
  });
});

describe('Date & Financial Year Utilities', () => {
  it('parses valid ISO date strings in UTC without timezone drift', () => {
    const d = parseISODateStrict('2026-04-13');
    expect(d).not.toBeNull();
    expect(d?.getUTCFullYear()).toBe(2026);
    expect(d?.getUTCMonth()).toBe(3); // 0-indexed April is 3
    expect(d?.getUTCDate()).toBe(13);
  });

  it('rejects invalid or impossible calendar dates', () => {
    expect(parseISODateStrict('31-99-2026')).toBeNull();
    expect(parseISODateStrict('2026-02-30')).toBeNull();
    expect(parseISODateStrict('2026-13-01')).toBeNull();
    expect(parseISODateStrict('invalid')).toBeNull();
    expect(parseISODateStrict('')).toBeNull();
  });

  it('derives accurate Indian Financial Year (April 1 - March 31)', () => {
    // April 1, 2026 starts FY 2026-2027
    const apr1 = parseISODateStrict('2026-04-01')!;
    expect(getFinancialYear(apr1)).toBe('2026-2027');
    expect(getShortFinancialYear(apr1)).toBe('26-27');

    // March 31, 2026 is part of FY 2025-2026
    const mar31 = parseISODateStrict('2026-03-31')!;
    expect(getFinancialYear(mar31)).toBe('2025-2026');
    expect(getShortFinancialYear(mar31)).toBe('25-26');

    // December 31, 2026 is part of FY 2026-2027
    const dec31 = parseISODateStrict('2026-12-31')!;
    expect(getFinancialYear(dec31)).toBe('2026-2027');
  });
});

describe('State & UTGST Jurisdiction Utilities', () => {
  it('validates state codes properly', () => {
    expect(isValidStateCode('09')).toBe(true); // Uttar Pradesh
    expect(isValidStateCode('27')).toBe(true); // Maharashtra
    expect(isValidStateCode('36')).toBe(true); // Telangana
    expect(isValidStateCode('99')).toBe(false); // Invalid
    expect(isValidStateCode('00')).toBe(false); // Invalid
    expect(isValidStateCode(null)).toBe(false);
  });

  it('correctly classifies UTGST vs SGST jurisdictions', () => {
    // UTs without legislature levy UTGST
    expect(isUTGSTApplicable('35')).toBe(true); // Andaman & Nicobar
    expect(isUTGSTApplicable('38')).toBe(true); // Ladakh
    expect(isUTGSTApplicable('04')).toBe(true); // Chandigarh
    expect(isUTGSTApplicable('26')).toBe(true); // Dadra & Nagar Haveli and Daman & Diu
    expect(isUTGSTApplicable('31')).toBe(true); // Lakshadweep

    // States and UTs with legislature levy SGST
    expect(isUTGSTApplicable('27')).toBe(false); // Maharashtra
    expect(isUTGSTApplicable('07')).toBe(false); // Delhi (has legislature)
    expect(isUTGSTApplicable('34')).toBe(false); // Puducherry (has legislature)
    expect(isUTGSTApplicable('01')).toBe(false); // Jammu and Kashmir (has legislature)

    // Other Territory (code 97) is governed by IGST Section 7(5)(a), NOT intra-UT UTGST
    expect(isUTGSTApplicable('97')).toBe(false);
    expect(getJurisdictionCategory('97')).toBe(JurisdictionCategory.OTHER_TERRITORY);
  });

  it('validates GSTIN structure and extracts PAN', () => {
    const validGstin = '24ZZZYB0002F8Z5';
    expect(isValidGSTINStructure(validGstin)).toBe(true);
    expect(extractPANFromGSTIN(validGstin)).toBe('ZZZYB0002F');

    // Invalid state prefix
    expect(isValidGSTINStructure('99ZZZYB0002F8Z5')).toBe(false);
    // Invalid length
    expect(isValidGSTINStructure('24ZZZYB0002F8Z')).toBe(false);
  });
});

describe('Logger Masking', () => {
  it('masks GSTIN correctly to prevent sensitive data leakage', () => {
    expect(maskGSTIN('24ZZZYB0002F8Z5')).toBe('24ZZZ******8Z5');
    expect(maskGSTIN('')).toBe('');
    expect(maskGSTIN('123')).toBe('***');
  });
});
