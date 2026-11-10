import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { defaultAmazonAdapter, AmazonSyntheticAdapter } from '../../src/adapters/amazon/amazon-synthetic.adapter.js';

const SUITE_ROOT = path.resolve(__dirname, '../../GSTFlow_Synthetic_Test_Suite');

describe('Amazon Synthetic Adapter - Schema & Header Detection', () => {
  const adapter = new AmazonSyntheticAdapter();

  it('infers report type correctly from CSV headers', () => {
    expect(adapter.inferReportType(['Transfer Invoice Number', 'Source GSTIN'])).toBe('STOCK_TRANSFER');
    expect(adapter.inferReportType(['Credit Note Number', 'Credit Note Total'])).toBe('CREDIT_NOTE');
    expect(adapter.inferReportType(['Invoice Number', 'Test Case ID', 'Expected Issue'])).toBe('EDGE_CASES');
    expect(adapter.inferReportType(['Unknown Col'])).toBe('UNKNOWN');
  });

  it('infers report type from file path as fallback', () => {
    expect(adapter.inferReportType([], 'path/to/synthetic_amazon_mtr_b2b.csv')).toBe('B2B');
    expect(adapter.inferReportType([], 'path/to/synthetic_amazon_mtr_b2c.csv')).toBe('B2C');
    expect(adapter.inferReportType([], 'path/to/synthetic_amazon_stock_transfer.csv')).toBe('STOCK_TRANSFER');
    expect(adapter.inferReportType([], 'path/to/synthetic_amazon_credit_notes.csv')).toBe('CREDIT_NOTE');
  });
});

describe('Amazon Synthetic Adapter - Dataset Verification Against Manifest', () => {
  it('streams and verifies B2B dataset (5,000 rows)', async () => {
    const filePath = path.join(SUITE_ROOT, 'amazon/synthetic_amazon_mtr_b2b.csv');
    let count = 0;
    let firstRow: any = null;

    for await (const record of defaultAmazonAdapter.streamRecords(filePath)) {
      count++;
      if (count === 1) firstRow = record;
    }

    expect(count).toBe(5000);
    expect(firstRow).not.toBeNull();
    expect(firstRow.sourceReport).toBe('SYNTHETIC_AMAZON_MTR_B2B');
    expect(firstRow.sourceRowNumber).toBe(3); // First data row has Source Row Number 3 in synthetic generator
    expect(firstRow.physicalLineNumber).toBe(2); // Line 1 is header, line 2 is first record
    expect(firstRow.rawFields['Invoice Number']).toBe('AMZ/26-27/0000001');
    expect(firstRow.rawFields['Recipient Type']).toBe('B2B');
  });

  it('streams and verifies B2C dataset (10,000 rows)', async () => {
    const filePath = path.join(SUITE_ROOT, 'amazon/synthetic_amazon_mtr_b2c.csv');
    let count = 0;
    let firstRow: any = null;

    for await (const record of defaultAmazonAdapter.streamRecords(filePath)) {
      count++;
      if (count === 1) firstRow = record;
    }

    expect(count).toBe(10000);
    expect(firstRow).not.toBeNull();
    expect(firstRow.sourceReport).toBe('SYNTHETIC_AMAZON_MTR_B2C');
    expect(firstRow.sourceRowNumber).toBe(6002);
    expect(firstRow.rawFields['Recipient Type']).toBe('B2C');
  });

  it('streams and verifies Stock Transfer dataset (1,000 rows)', async () => {
    const filePath = path.join(SUITE_ROOT, 'amazon/synthetic_amazon_stock_transfer.csv');
    let count = 0;
    let firstRow: any = null;

    for await (const record of defaultAmazonAdapter.streamRecords(filePath)) {
      count++;
      if (count === 1) firstRow = record;
    }

    expect(count).toBe(1000);
    expect(firstRow).not.toBeNull();
    expect(firstRow.reportType).toBe('STOCK_TRANSFER');
    expect(firstRow.sourceReport).toBe('SYNTHETIC_AMAZON_STOCK_TRANSFER');
    expect(firstRow.rawFields['Transfer Invoice Number']).toBe('ST/26-27/000001');
  });

  it('streams and verifies Credit Notes dataset (2,000 rows)', async () => {
    const filePath = path.join(SUITE_ROOT, 'amazon/synthetic_amazon_credit_notes.csv');
    let count = 0;
    let firstRow: any = null;

    for await (const record of defaultAmazonAdapter.streamRecords(filePath)) {
      count++;
      if (count === 1) firstRow = record;
    }

    expect(count).toBe(2000);
    expect(firstRow).not.toBeNull();
    expect(firstRow.reportType).toBe('CREDIT_NOTE');
    expect(firstRow.sourceReport).toBe('SYNTHETIC_AMAZON_CREDIT_NOTES');
    expect(firstRow.rawFields['Credit Note Number']).toBe('CN/26-27/000001');
    expect(firstRow.rawFields['Original Invoice Number']).toBe('AMZ/26-27/0000038');
  });

  it('streams and verifies Invalid Transactions dataset (500 rows)', async () => {
    const filePath = path.join(SUITE_ROOT, 'edge_cases/synthetic_invalid_transactions.csv');
    let count = 0;
    let firstRow: any = null;

    for await (const record of defaultAmazonAdapter.streamRecords(filePath)) {
      count++;
      if (count === 1) firstRow = record;
    }

    expect(count).toBe(500);
    expect(firstRow).not.toBeNull();
    expect(firstRow.reportType).toBe('EDGE_CASES');
    expect(firstRow.rawFields['Test Case ID']).toBe('EDGE-0001');
    expect(firstRow.rawFields['Expected Issue']).toBe('MISSING_BUYER_GSTIN');
  });

  it('verifies manifest cumulative row count across all synthetic files (18,500 total rows)', () => {
    const manifestPath = path.join(SUITE_ROOT, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    let totalManifestRows = 0;
    for (const fileKey of Object.keys(manifest.files)) {
      totalManifestRows += manifest.files[fileKey].rows;
    }
    expect(totalManifestRows).toBe(18500);
  });

  it('gracefully handles missing columns or malformed rows without crashing the stream', async () => {
    const tempCsvPath = path.join(__dirname, '../temp-malformed-test.csv');
    // Row 1: Header (3 columns)
    // Row 2: Standard (3 columns)
    // Row 3: Missing columns (2 columns)
    // Row 4: Extra columns (4 columns)
    const csvContent = 'Col1,Col2,Col3\nValA1,ValA2,ValA3\nValB1,ValB2\nValC1,ValC2,ValC3,ValC4\n';
    fs.writeFileSync(tempCsvPath, csvContent, 'utf-8');

    try {
      const records = await defaultAmazonAdapter.parseFile(tempCsvPath);
      expect(records.length).toBe(3); // Zero silent drops
      expect(records[0].rawFields['Col1']).toBe('ValA1');
      expect(records[1].parseErrors).toBeDefined(); // Column count mismatch detected
      expect(records[2].parseErrors).toBeDefined(); // Column count mismatch detected
    } finally {
      if (fs.existsSync(tempCsvPath)) {
        fs.unlinkSync(tempCsvPath);
      }
    }
  });
});
