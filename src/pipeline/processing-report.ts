import { Decimal } from '../utils/decimal.js';

export interface PrimaryOutcomeCounts {
  valid: number;
  warning: number;
  review: number;
  error: number;
  total: number;
}

export interface CreditNoteReconciliationSummary {
  totalCreditNotes: number;
  matchedFull: number;
  matchedPartial: number;
  unmatchedOrphan: number;
  ambiguousMatches: number;
  valueExceeded: number;
  jurisdictionMismatch: number;
  matchedB2B: number;
  matchedB2C: number;
}

export interface IssueSeverityCounts {
  errors: number;
  warnings: number;
  reviews: number;
  total: number;
}

export interface PerformanceMetrics {
  durationMs: number;
  recordsPerSecond: number;
  startMemoryHeapUsedMB: number;
  peakMemoryHeapUsedMB: number;
}

export interface ProcessingReport {
  timestamp: string;
  filesProcessed: string[];
  totalRecordsIngested: number;
  outcomes: PrimaryOutcomeCounts;
  issuesBySeverity: IssueSeverityCounts;
  reconciliationSummary: CreditNoteReconciliationSummary;
  performance: PerformanceMetrics;
  zeroDataLossVerified: boolean;
}
