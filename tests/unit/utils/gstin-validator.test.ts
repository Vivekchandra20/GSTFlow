import { describe, it, expect } from 'vitest';
import {
  calculateGstinChecksum,
  validateGstin,
  isValidGstin
} from '../../../src/utils/gstin-validator.js';

describe('GSTIN Validator & Modulo-36 Checksum Suite', () => {
  it('correctly calculates Modulo-36 check digits for authentic GSTIN roots', () => {
    // 27AAPFU0939F1Z -> V
    expect(calculateGstinChecksum('27AAPFU0939F1Z')).toBe('V');
    // 29AABCU9603R1Z -> J
    expect(calculateGstinChecksum('29AABCU9603R1Z')).toBe('J');
    // 07AAAAA0000A1Z -> 4
    expect(calculateGstinChecksum('07AAAAA0000A1Z')).toBe('4');
    // 33AAACA1234A1Z -> R
    expect(calculateGstinChecksum('33AAACA1234A1Z')).toBe('R');
  });

  it('validates authentic, structurally valid GSTINs with checksum', () => {
    const res = validateGstin('27AAPFU0939F1ZV');
    expect(res.isValid).toBe(true);
    expect(res.normalizedGstin).toBe('27AAPFU0939F1ZV');
    expect(res.stateCode).toBe('27');
    expect(res.stateName).toBe('Maharashtra');
    expect(res.pan).toBe('AAPFU0939F');
    expect(res.entityNumber).toBe('1');
    expect(res.checksum).toBe('V');
    expect(res.expectedChecksum).toBe('V');
    expect(res.errors).toHaveLength(0);

    expect(isValidGstin('29AABCU9603R1ZJ')).toBe(true);
    expect(isValidGstin('07AAAAA0000A1Z4')).toBe(true);
    expect(isValidGstin('33AAACA1234A1ZR')).toBe(true);
  });

  it('handles lowercase and whitespace normalization gracefully', () => {
    const res = validateGstin('  27aapfu0939f1zv  ');
    expect(res.isValid).toBe(true);
    expect(res.normalizedGstin).toBe('27AAPFU0939F1ZV');
    expect(res.stateCode).toBe('27');
    expect(res.pan).toBe('AAPFU0939F');
    expect(isValidGstin('  27aapfu0939f1zv  ')).toBe(true);
  });

  it('rejects GSTINs with invalid length', () => {
    // Too short (14 chars)
    const shortRes = validateGstin('27AAPFU0939F1Z');
    expect(shortRes.isValid).toBe(false);
    expect(shortRes.errors.some((e) => e.includes('must be exactly 15 characters'))).toBe(true);

    // Too long (16 chars)
    const longRes = validateGstin('27AAPFU0939F1ZVV');
    expect(longRes.isValid).toBe(false);
    expect(longRes.errors.some((e) => e.includes('must be exactly 15 characters'))).toBe(true);

    // Empty or non-string
    expect(validateGstin('').isValid).toBe(false);
    expect(validateGstin(null as any).isValid).toBe(false);
  });

  it('rejects GSTINs with invalid state codes not in directory', () => {
    // 00 is not a valid GST state code
    const res00 = validateGstin('00AAPFU0939F1ZV');
    expect(res00.isValid).toBe(false);
    expect(res00.errors.some((e) => e.includes('Invalid state code'))).toBe(true);

    // 99 is not in catalogue
    const res99 = validateGstin('99AAPFU0939F1ZV');
    expect(res99.isValid).toBe(false);
    expect(res99.errors.some((e) => e.includes('Invalid state code'))).toBe(true);
  });

  it('rejects GSTINs with malformed PAN component', () => {
    // 5 letters, 4 digits, 1 letter. Here: 4 letters, 5 digits ('AAPF00939F')
    const res = validateGstin('27AAPF00939F1ZV');
    expect(res.isValid).toBe(false);
    expect(res.errors.some((e) => e.includes('Invalid PAN component'))).toBe(true);
  });

  it('rejects GSTINs where the 14th character is not Z', () => {
    // 14th character is 'A' instead of 'Z'
    const res = validateGstin('27AAPFU0939F1AV');
    expect(res.isValid).toBe(false);
    expect(res.errors.some((e) => e.includes("14th character of GSTIN must be 'Z'"))).toBe(true);
  });

  it('rejects GSTINs where the 15th checksum character does not match calculation', () => {
    // Expected is 'V', provided is 'X'
    const res = validateGstin('27AAPFU0939F1ZX');
    expect(res.isValid).toBe(false);
    expect(res.errors.some((e) => e.includes("Invalid GSTIN checksum character 'X'. Expected 'V'"))).toBe(true);
  });

  it('allows skipping checksum enforcement when explicitly configured', () => {
    // Structural validity only (e.g. for synthetic fixtures)
    const res = validateGstin('27AAPFU0939F1ZX', { enforceChecksum: false });
    expect(res.isValid).toBe(true);
    expect(res.checksum).toBe('X');
    expect(res.expectedChecksum).toBe('V');
  });
});
