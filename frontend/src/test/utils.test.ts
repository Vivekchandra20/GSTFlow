import { describe, it, expect } from 'vitest';
import { formatInr } from '../utils/currency';
import { isValidGstin, getStateNameByCode, extractPanFromGstin } from '../utils/gstin';
import { formatDate, formatDateTime, formatRelativeTime } from '../utils/dates';

describe('Frontend Financial Utilities', () => {
  describe('formatInr (Indian Number Formatting)', () => {
    it('formats basic amounts with Indian grouping', () => {
      expect(formatInr(125000)).toBe('₹1,25,000.00');
      expect(formatInr(1250000)).toBe('₹12,50,000.00');
      expect(formatInr(12345678)).toBe('₹1,23,45,678.00');
    });

    it('formats string amounts correctly', () => {
      expect(formatInr('14850000.50')).toBe('₹1,48,50,000.50');
      expect(formatInr('0.00')).toBe('₹0.00');
    });

    it('handles negative values correctly', () => {
      expect(formatInr(-421000)).toBe('-₹4,21,000.00');
    });

    it('supports options (no symbol, no decimals, compact)', () => {
      expect(formatInr(125000, { showSymbol: false })).toBe('1,25,000.00');
      expect(formatInr(125000, { showDecimals: false })).toBe('₹1,25,000');
      expect(formatInr(1500000, { compact: true })).toBe('₹15.00 L');
      expect(formatInr(25000000, { compact: true })).toBe('₹2.50 Cr');
    });

    it('handles null, undefined and invalid inputs safely', () => {
      expect(formatInr(null)).toBe('₹0.00');
      expect(formatInr(undefined)).toBe('₹0.00');
      expect(formatInr('invalid')).toBe('₹0.00');
    });
  });

  describe('GSTIN Validation & Resolution', () => {
    it('validates authentic Indian GSTIN formats', () => {
      expect(isValidGstin('27AAPFU0939F1ZV')).toBe(true); // Maharashtra
      expect(isValidGstin('29ABCDE1234F1Z5')).toBe(true); // Karnataka
      expect(isValidGstin('07AAAAA0000A1Z5')).toBe(true); // Delhi
    });

    it('rejects invalid GSTIN formats and invalid state codes', () => {
      expect(isValidGstin('')).toBe(false);
      expect(isValidGstin('SHORT')).toBe(false);
      expect(isValidGstin('99AAPFU0939F1ZV')).toBe(true); // 99 is Centre Jurisdiction
      expect(isValidGstin('00AAPFU0939F1ZV')).toBe(false); // 00 is not a valid state code
      expect(isValidGstin('27AAPFU0939F1Z')).toBe(false); // only 14 chars
    });

    it('extracts PAN correctly from 15-character GSTIN', () => {
      expect(extractPanFromGstin('27AAPFU0939F1ZV')).toBe('AAPFU0939F');
      expect(extractPanFromGstin('29ABCDE1234F1Z5')).toBe('ABCDE1234F');
      expect(extractPanFromGstin('')).toBe(null);
    });

    it('resolves state names from 2-digit state code', () => {
      expect(getStateNameByCode('27')).toBe('Maharashtra');
      expect(getStateNameByCode('29')).toBe('Karnataka');
      expect(getStateNameByCode('07')).toBe('Delhi');
      expect(getStateNameByCode('24')).toBe('Gujarat');
      expect(getStateNameByCode('98')).toBe('State (98)');
    });
  });

  describe('Date Formatting Utilities', () => {
    it('formats ISO dates to standard Indian format', () => {
      const formatted = formatDate('2026-11-09T14:30:00.000Z');
      expect(formatted).toContain('2026');
      expect(formatDate(null)).toBe('—');
      expect(formatDate('invalid')).toBe('—');
    });

    it('formats date and time accurately', () => {
      const formatted = formatDateTime('2026-11-09T14:30:00.000Z');
      expect(formatted).toContain('2026');
      expect(formatDateTime(null)).toBe('—');
    });

    it('computes relative time gracefully', () => {
      const now = new Date();
      expect(formatRelativeTime(now.toISOString())).toBe('just now');
      expect(formatRelativeTime(null)).toBe('—');
    });
  });
});
