# GSTFlow Synthetic Test Data Suite

Version: 1.0.0  
Generated: 2026-11-07

**SYNTHETIC TEST DATA ONLY — NOT OFFICIAL AMAZON REPORTS — NOT FOR GST FILING.**

This package provides reproducible development fixtures for GSTFlow's CSV parsing, normalization, validation, reconciliation, and testing work.

## Contents
See `manifest.json` for row counts and file purposes. See `documentation/data_dictionary.md` for field definitions and caveats.

## Recommended use with Antigravity
1. Put this folder under your GSTFlow repository, for example `backend/tests/fixtures/gstflow-synthetic/`.
2. Tell the coding agent that these are canonical synthetic fixtures, not exact Amazon source exports.
3. Implement a parser/adapter that maps these headers into a normalized internal model.
4. Write tests using `Expected Issue` in the invalid fixture and `test_scenarios.json`.
5. Do not generate portal-uploadable JSON from these files until the current official GST schema and real marketplace source formats have been independently verified.

## Important limitations
- No exact Amazon MTR header compatibility is claimed.
- GSTIN-like values are fabricated; their registration/checksum validity is not asserted.
- Tax rates and tax treatment are illustrative test values.
- The GSTR-1 output format is intentionally not represented as portal-ready.
- No actual seller/customer personal data is included.
