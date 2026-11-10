import pino from 'pino';

/**
 * Mask a GSTIN for audit logging while retaining state and checksum shape.
 * Example: '24ZZZYB0002F8Z5' -> '24ZZZ******8Z5'
 */
export function maskGSTIN(gstin: string | null | undefined): string {
  if (!gstin) return '';
  const trimmed = gstin.trim();
  if (trimmed.length < 8) return '***';
  return `${trimmed.slice(0, 5)}******${trimmed.slice(-3)}`;
}

const SENSITIVE_KEY_PATTERNS = [
  /gstin/i,
  /name/i,
  /email/i,
  /phone/i,
  /address/i,
  /contact/i,
  /buyer/i,
  /customer/i
];

/**
 * Deeply sanitizes an object or array to prevent sensitive customer details and unredacted raw records
 * from leaking into loggers, third-party APMs, or console outputs.
 */
export function sanitizeLogPayload(data: any, depth = 0): any {
  if (data === null || data === undefined) return data;
  if (depth > 6) return '[MAX_DEPTH]'; // Guard against circular structures

  if (typeof data === 'string') {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => sanitizeLogPayload(item, depth + 1));
  }

  if (typeof data === 'object') {
    const sanitized: Record<string, any> = {};

    for (const [key, value] of Object.entries(data)) {
      const lowerKey = key.toLowerCase();

      // Redact entire raw record dictionaries in logs
      if (key === 'rawRecord' || key === 'rawFields') {
        sanitized[key] = '[REDACTED_RAW_EVIDENCE]';
        continue;
      }

      // Mask GSTIN fields specifically
      if (lowerKey.includes('gstin') && typeof value === 'string') {
        sanitized[key] = maskGSTIN(value);
        continue;
      }

      // Redact PII (names, emails, phones, addresses)
      const isSensitive = SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
      if (isSensitive && typeof value === 'string' && value.length > 0) {
        sanitized[key] = '[REDACTED]';
        continue;
      }

      // Recursively sanitize nested objects
      sanitized[key] = sanitizeLogPayload(value, depth + 1);
    }

    return sanitized;
  }

  return data;
}

/**
 * Strips raw records and customer personal details from SourceReference for safe external reporting.
 */
export function sanitizeSourceReference<T extends { rawRecord?: Record<string, any> }>(sourceRef: T): T {
  const copy = { ...sourceRef };
  if (copy.rawRecord) {
    copy.rawRecord = {
      _redacted: true,
      _message: 'Raw source fields redacted for privacy. Original source retained in secure storage.'
    };
  }
  return copy;
}

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    log(obj: Record<string, any>) {
      return sanitizeLogPayload(obj);
    }
  }
});
