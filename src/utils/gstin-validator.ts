import { INDIAN_STATE_CODES, StateJurisdiction } from './state-codes.js';

export const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const GSTIN_FORMAT_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export interface GstinValidationResult {
  isValid: boolean;
  normalizedGstin: string;
  stateCode: string | null;
  stateName: string | null;
  pan: string | null;
  entityNumber: string | null;
  checksum: string | null;
  expectedChecksum: string | null;
  errors: string[];
}

export interface GstinValidationOptions {
  enforceChecksum?: boolean;
}

/**
 * Computes the 15th check character for the first 14 characters of an Indian GSTIN
 * using the official GSTN Modulo-36 Luhn-like algorithm.
 *
 * Algorithm details:
 * 1. Base-36 characters: '0'-'9' (0-9) and 'A'-'Z' (10-35).
 * 2. Alternating multiplication factor:
 *    - Position 1 (index 0): factor = 1
 *    - Position 2 (index 1): factor = 2
 *    - ...
 * 3. For each char, sum the quotient and remainder in base 36: floor(product / 36) + (product % 36).
 * 4. Remainder = sum % 36.
 * 5. Check character index = (36 - remainder) % 36.
 */
export function calculateGstinChecksum(first14: string): string {
  if (!first14 || first14.length !== 14) {
    throw new Error(`Checksum calculation requires exactly 14 characters; received '${first14}'.`);
  }

  const clean14 = first14.toUpperCase();
  let total = 0;

  for (let i = 0; i < 14; i++) {
    const ch = clean14[i];
    const charValue = GSTIN_CHARS.indexOf(ch);
    if (charValue === -1) {
      throw new Error(`Invalid base-36 character '${ch}' at position ${i + 1} in GSTIN '${first14}'.`);
    }

    const factor = (i % 2 === 0) ? 1 : 2;
    const product = charValue * factor;
    total += Math.floor(product / 36) + (product % 36);
  }

  const remainder = total % 36;
  const checkCodeIndex = (36 - remainder) % 36;
  return GSTIN_CHARS[checkCodeIndex];
}

/**
 * Deterministically validates the structure, state code, PAN component,
 * 14th character ('Z'), and 15th check digit of a GSTIN.
 */
export function validateGstin(
  gstin: string | null | undefined,
  options: GstinValidationOptions = { enforceChecksum: true }
): GstinValidationResult {
  const errors: string[] = [];

  if (!gstin || typeof gstin !== 'string') {
    return {
      isValid: false,
      normalizedGstin: '',
      stateCode: null,
      stateName: null,
      pan: null,
      entityNumber: null,
      checksum: null,
      expectedChecksum: null,
      errors: ['GSTIN is required and must be a non-empty string.']
    };
  }

  const normalized = gstin.trim().toUpperCase();

  // 1. Length Check
  if (normalized.length !== 15) {
    errors.push(`GSTIN must be exactly 15 characters; received ${normalized.length}.`);
    return {
      isValid: false,
      normalizedGstin: normalized,
      stateCode: normalized.length >= 2 ? normalized.slice(0, 2) : null,
      stateName: null,
      pan: null,
      entityNumber: null,
      checksum: null,
      expectedChecksum: null,
      errors
    };
  }

  const stateCode = normalized.slice(0, 2);
  const pan = normalized.slice(2, 12);
  const entityNumber = normalized[12];
  const fourteenthChar = normalized[13];
  const checksumChar = normalized[14];

  // 2. State Code Check
  const stateJurisdiction: StateJurisdiction | undefined = INDIAN_STATE_CODES[stateCode];
  if (!stateJurisdiction) {
    errors.push(`Invalid state code '${stateCode}'. Must match official GST state directory.`);
  }

  // 3. PAN Structure Check (5 letters, 4 digits, 1 letter)
  if (!PAN_REGEX.test(pan)) {
    errors.push(`Invalid PAN component '${pan}' in GSTIN. Must follow statutory 10-character PAN pattern.`);
  }

  // 4. Entity Number Check (1-9 or A-Z)
  if (!/^[1-9A-Z]$/.test(entityNumber)) {
    errors.push(`Invalid 13th entity indicator '${entityNumber}'. Must be 1-9 or A-Z.`);
  }

  // 5. 14th Character Check (Normally 'Z')
  if (fourteenthChar !== 'Z') {
    errors.push(`14th character of GSTIN must be 'Z'; received '${fourteenthChar}'.`);
  }

  // 6. Base-36 Checksum Verification
  let expectedChecksum: string | null = null;
  try {
    expectedChecksum = calculateGstinChecksum(normalized.slice(0, 14));
    if (options.enforceChecksum !== false && checksumChar !== expectedChecksum) {
      errors.push(
        `Invalid GSTIN checksum character '${checksumChar}'. Expected '${expectedChecksum}'.`
      );
    }
  } catch (err: any) {
    errors.push(`Checksum calculation failed: ${err.message}`);
  }

  const isValid = errors.length === 0;

  return {
    isValid,
    normalizedGstin: normalized,
    stateCode,
    stateName: stateJurisdiction?.name || null,
    pan,
    entityNumber,
    checksum: checksumChar,
    expectedChecksum,
    errors
  };
}

/**
 * Fast boolean helper to check GSTIN structural & checksum validity.
 */
export function isValidGstin(
  gstin: string | null | undefined,
  enforceChecksum: boolean = true
): boolean {
  return validateGstin(gstin, { enforceChecksum }).isValid;
}
