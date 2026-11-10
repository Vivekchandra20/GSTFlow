# Synthetic Amazon MTR Test Fixtures (Phase 5A)

> [!CRITICAL]
> **SYNTHETIC TEST SUITE NOTICE & DISCLAIMER**
> 
> Every record, order ID, invoice number, financial value, and tax calculation in this directory is **100% SYNTHETIC**.
> 
> - These files are **NOT** downloaded from Amazon Seller Central.
> - They are **NOT** official Amazon exports.
> - They do **NOT** represent genuine taxpayers, commercial entities, or live seller data.
> - They are generated in strict adherence to official Amazon India Seller Central documentation, CBIC GST circulars, and GSTFlow domain contracts.
> - **GENUINE AMAZON SELLER EXPORT VERIFICATION IS EXPLICITLY DEFERRED TO PHASE 5B.**
> - Evidence Classification: `SYNTHETIC_TESTED` / `DOCUMENTATION_VERIFIED`.

---

## Synthetic Dataset Catalog

| Dataset File | Scenario Category | Documented Characteristics Tested |
|---|---|---|
| `dataset_a_b2b_shipments.csv` | Dataset A: B2B Forward Shipments | Multiple seller GSTINs (MH 27, KA 29), intrastate & interstate, multi-line invoices, Section 10(1)(b) POS |
| `dataset_b_b2c_shipments.csv` | Dataset B: B2C Retail Supplies | POS determination: Section 10(1)(a) pre-Oct 2023 vs Section 10(1)(ca) post-Oct 2023 & Circular 209/03/2024-GST |
| `dataset_c_refunds.csv` | Dataset C: Credit Notes & Returns | Full returns, partial returns, multiple returns against single invoice, unmatched orphan refunds |
| `dataset_d_shipping_giftwrap.csv` | Dataset D: Composite Supplies & Discounts | Principal vs freight vs gift-wrap bases, item and shipping promotional discounts, separate tax heads |
| `dataset_e_historical_formats.csv` | Dataset E: Header Versions & Formats | Pre-19 Feb 2021 `Customer Ship to GSTIN` vs Post-19 Feb 2021 `Customer Bill to GSTIN`, missing optional columns |
| `dataset_f_invalid_records.csv` | Dataset F: Defective & Invalid Rows | Missing mandatory fields, malformed dates, invalid GSTINs, negative shipments, inconsistent tax components |
| `dataset_g_stock_transfers_tcs.csv` | Dataset G: Stock Transfers & Section 52 TCS | 32-column STR schema, `FC_TRANSFER`, `FC_REMOVAL`, Section 25(4) distinct person pan matching, IRN fields, TCS deductions |
