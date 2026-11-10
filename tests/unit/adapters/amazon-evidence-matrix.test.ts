import { describe, it, expect } from 'vitest';
import {
  MappingEvidence,
  AMAZON_FIELD_EVIDENCE_CATALOG,
  AmazonReportFormat,
  AmazonHeaderVersion
} from '../../../src/adapters/amazon/evidence-classification.js';
import { TIER1_VERIFIED_ALIASES } from '../../../src/adapters/amazon/amazon-live-header-resolver.js';

describe('Phase 5A: Amazon MTR Statutory Evidence Classification Matrix', () => {
  it('enforces that REAL_WORLD_VERIFIED is strictly unavailable in Phase 5A', () => {
    // Invariant: Phase 5A does not have access to genuine Amazon seller exports.
    // Real-world verification must remain unavailable until Phase 5B.
    const classifications = Object.values(AMAZON_FIELD_EVIDENCE_CATALOG).map(
      (entry) => entry.classification
    );

    const hasRealWorldVerified = classifications.some(
      (c) => c === MappingEvidence.REAL_WORLD_VERIFIED
    );

    expect(hasRealWorldVerified).toBe(false);
  });

  it('guarantees that every Tier 1 verified header is cataloged with statutory purpose and documentation source', () => {
    const canonicalFields = Object.keys(TIER1_VERIFIED_ALIASES);

    for (const field of canonicalFields) {
      const catalogEntry = AMAZON_FIELD_EVIDENCE_CATALOG[field];
      expect(catalogEntry).toBeDefined();
      expect(catalogEntry.canonicalField).toBe(field);
      expect(catalogEntry.primaryHeader).toBeDefined();
      expect(catalogEntry.aliases.length).toBeGreaterThan(0);
      expect(catalogEntry.docSource).toBeDefined();
      expect(catalogEntry.docSource.length).toBeGreaterThan(5);
      expect(catalogEntry.statutoryPurpose).toBeDefined();
      expect(catalogEntry.description).toBeDefined();
      expect(
        catalogEntry.classification === MappingEvidence.DOCUMENTATION_VERIFIED ||
          catalogEntry.classification === MappingEvidence.EXISTING_ENGINE_VERIFIED
      ).toBe(true);
    }
  });

  it('verifies report format and header version enumerations adhere to documented contracts', () => {
    expect(AmazonReportFormat.MTR_B2B).toBe('MTR_B2B');
    expect(AmazonReportFormat.MTR_B2C).toBe('MTR_B2C');
    expect(AmazonReportFormat.STOCK_TRANSFER).toBe('STOCK_TRANSFER');
    expect(AmazonReportFormat.MTR_UNIFIED).toBe('MTR_UNIFIED');

    expect(AmazonHeaderVersion.V2021_POST_FEB).toBe('V2021_POST_FEB');
    expect(AmazonHeaderVersion.V2021_PRE_FEB).toBe('V2021_PRE_FEB');
    expect(AmazonHeaderVersion.STR_V1).toBe('STR_V1');
  });
});
