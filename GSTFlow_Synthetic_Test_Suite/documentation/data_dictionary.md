# GSTFlow synthetic dataset suite — data dictionary

## Critical disclaimer
Every record and identifier in this suite is synthetic. These files are NOT downloaded from Amazon, are NOT official Amazon MTR exports, do NOT represent real taxpayers, and are NOT suitable for filing. GSTIN-like values are fabricated format-shaped test identifiers; no registration or checksum validity is asserted.

## Files
- `amazon/synthetic_amazon_mtr_b2b.csv`: 5,000 synthetic B2B-style invoice rows.
- `amazon/synthetic_amazon_mtr_b2c.csv`: 10,000 synthetic B2C-style invoice rows.
- `amazon/synthetic_amazon_stock_transfer.csv`: 1,000 synthetic stock-transfer rows.
- `amazon/synthetic_amazon_credit_notes.csv`: 2,000 synthetic credit notes linked to synthetic invoices.
- `edge_cases/synthetic_invalid_transactions.csv`: 500 intentionally mutated records. `Expected Issue` identifies the injected defect.
- `expected_outputs/test_scenarios.json`: expected high-level behavior for 15 test scenarios.

## Schema notes
The CSV headers form a GSTFlow canonical test schema inspired by publicly described Amazon tax-report fields. They are not guaranteed to match Amazon's exact report headers. Build an adapter that maps actual source headers to this canonical schema when genuine sample reports become available.

## Important field definitions
- `Seller GSTIN`: fabricated seller registration-shaped identifier.
- `Customer Bill To GSTIN`: fabricated recipient identifier; blank for B2C.
- `Invoice Number`: synthetic invoice reference.
- `Transaction Type`: Shipment in sales fixtures; Stock Transfer in transfer fixture.
- `Taxable Value`: product taxable value before shipping.
- `Shipping Taxable Value`: separately represented shipping taxable amount.
- `Tax Rate`: illustrative combined rate used to generate arithmetic.
- `CGST/SGST/IGST Rate` and `Amount`: split tax components based on the synthetic origin/destination state codes.
- `Place of Supply`: synthetic destination state.
- `Credit Note Number`: blank in sales fixtures; credit notes are in their own file.
- `Source Report`: explicitly labels the synthetic source.

## Suggested processing rules for tests
1. Do not use Order ID alone as a line-item primary key.
2. Preserve multiple SKU lines belonging to one order.
3. Do not treat every cancelled or pending order as a taxable supply.
4. Do not infer B2B solely from a platform flag; require recipient/invoice evidence.
5. Route refunds and credit notes through a separate reconciliation path.
6. Do not treat stock transfers as ordinary customer sales.
7. Never silently discard invalid rows; return row-level errors/warnings.
8. Make tax rules and GSTR-1 mapping versioned/configurable.
9. Treat these fixtures as test inputs only, never as production tax data.

## Arithmetic
The synthetic sales and stock-transfer fixtures are internally generated to balance taxable values and tax components to two decimal places under the chosen illustrative rates. The credit-note fixture reverses a selected proportion of the linked synthetic invoice tax components. Production rounding and statutory treatment must be verified independently.
