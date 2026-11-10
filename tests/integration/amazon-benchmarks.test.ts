import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AmazonMtrLiveAdapter } from '../../src/adapters/amazon/amazon-live.adapter.js';
import { PipelineOrchestrator } from '../../src/pipeline/pipeline-orchestrator.js';

describe('Phase 5A: Amazon MTR Adapter & Pipeline Throughput Benchmarks', () => {
  const tempDir = path.join(os.tmpdir(), `gstflow-amazon-benchmarks-${Date.now()}`);
  const bench1kPath = path.join(tempDir, 'amazon_mtr_benchmark_1000.csv');
  const bench10kPath = path.join(tempDir, 'amazon_mtr_benchmark_10000.csv');

  function generateSyntheticCsv(filePath: string, recordCount: number): void {
    const headers = [
      'Seller GSTIN',
      'Invoice Number',
      'Invoice Date',
      'Transaction Type',
      'Order ID',
      'Shipment ID',
      'Shipment Item ID',
      'ASIN',
      'SKU',
      'Item Description',
      'HSN/SAC',
      'Product Tax Code',
      'Quantity',
      'Bill From City',
      'Bill From State',
      'Ship From State',
      'Ship From City',
      'Ship To State',
      'Ship To City',
      'Customer Bill to GSTIN',
      'Place of Supply',
      'Principal Amount Basis',
      'Shipping Amount Basis',
      'Gift Wrap Amount Basis',
      'Item Promo Discount Basis',
      'Shipping Promo Discount Basis',
      'Tax Exclusive Gross',
      'CGST Rate',
      'CGST Amount',
      'SGST Rate',
      'SGST Amount',
      'UTGST Rate',
      'UTGST Amount',
      'IGST Rate',
      'IGST Amount',
      'Compensatory Cess Amount',
      'Total Tax Amount',
      'Invoice Amount',
      'TCS CGST Amount',
      'TCS SGST Amount',
      'TCS IGST Amount',
      'Fulfillment Channel',
      'Warehouse ID',
      'Credit Note No',
      'Credit Note Date'
    ].join(',');

    const stream = fs.createWriteStream(filePath, { encoding: 'utf-8' });
    stream.write(headers + '\n');

    for (let i = 1; i <= recordCount; i++) {
      const isInterstate = i % 2 === 0;
      const invNum = `INV-BENCH-${String(i).padStart(6, '0')}`;
      const orderId = `408-${String(i).padStart(7, '0')}-0000001`;
      const baseAmt = 1000.0;
      const shipAmt = 50.0;
      const grossAmt = baseAmt + shipAmt;

      let cgstAmt = 0;
      let sgstAmt = 0;
      let igstAmt = 0;
      let pos = '27';
      let shipToState = 'Maharashtra';
      let buyerGstin = i % 4 === 0 ? '27AABCT3518Q1ZV' : '';

      if (isInterstate) {
        pos = '07';
        shipToState = 'Delhi';
        buyerGstin = i % 4 === 0 ? '07AAAAA0000A1Z5' : '';
        igstAmt = Math.round(grossAmt * 0.18 * 100) / 100;
      } else {
        cgstAmt = Math.round(grossAmt * 0.09 * 100) / 100;
        sgstAmt = Math.round(grossAmt * 0.09 * 100) / 100;
      }

      const totalTax = isInterstate ? igstAmt : cgstAmt + sgstAmt;
      const invAmt = Math.round((grossAmt + totalTax) * 100) / 100;

      const row = [
        '27AAPFU0939F1ZV',
        invNum,
        '2026-10-15',
        'Shipment',
        orderId,
        `SHIP-${i}`,
        `ITEM-${i}`,
        'B07BENCH01',
        `SKU-BENCH-${i % 100}`,
        'Benchmark Consumer Goods Line',
        '84716070',
        'A_GEN_STANDARD',
        '1',
        'Mumbai',
        'Maharashtra',
        'Maharashtra',
        'Mumbai',
        shipToState,
        'City',
        buyerGstin,
        pos,
        baseAmt.toFixed(2),
        shipAmt.toFixed(2),
        '0.00',
        '0.00',
        '0.00',
        grossAmt.toFixed(2),
        isInterstate ? '0.00' : '0.09',
        cgstAmt.toFixed(2),
        isInterstate ? '0.00' : '0.09',
        sgstAmt.toFixed(2),
        '0.00',
        '0.00',
        isInterstate ? '0.18' : '0.00',
        igstAmt.toFixed(2),
        '0.00',
        totalTax.toFixed(2),
        invAmt.toFixed(2),
        '0.00',
        '0.00',
        '0.00',
        'AFN',
        'BOM5',
        '',
        ''
      ].join(',');

      stream.write(row + '\n');
    }

    stream.end();
  }

  beforeAll(async () => {
    fs.mkdirSync(tempDir, { recursive: true });
    generateSyntheticCsv(bench1kPath, 1000);
    generateSyntheticCsv(bench10kPath, 10000);
    // Allow small I/O write settling
    await new Promise((resolve) => setTimeout(resolve, 300));
  });

  afterAll(() => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup error in temp
    }
  });

  it('benchmarks streaming normalization throughput on 1,000 synthetic records', async () => {
    const adapter = new AmazonMtrLiveAdapter({
      sourceReportName: 'amazon_mtr_benchmark_1000.csv'
    });

    const startMemoryMB = Math.round(process.memoryUsage().heapUsed / (1024 * 1024));
    const startTime = Date.now();
    let recordCount = 0;

    for await (const record of adapter.streamRecords(bench1kPath)) {
      recordCount++;
      expect(record.recordType).toBe('OUTWARD_SUPPLY');
    }

    const durationMs = Date.now() - startTime;
    const endMemoryMB = Math.round(process.memoryUsage().heapUsed / (1024 * 1024));
    const throughput = durationMs > 0 ? Math.round((recordCount / durationMs) * 1000) : recordCount;

    expect(recordCount).toBe(1000);
    expect(throughput).toBeGreaterThan(1000); // Exceeds 1,000 records/sec target
    expect(endMemoryMB - startMemoryMB).toBeLessThan(100); // Bounded memory growth (<100MB)

    console.log(`\n--- Benchmark: 1,000 Records ---`);
    console.log(`Records:    ${recordCount}`);
    console.log(`Duration:   ${durationMs} ms`);
    console.log(`Throughput: ${throughput} records/sec`);
    console.log(`Heap Delta: ${endMemoryMB - startMemoryMB} MB`);
  });

  it('benchmarks full end-to-end pipeline ingestion throughput on 10,000 synthetic records', async () => {
    const orchestrator = new PipelineOrchestrator();

    const startMemoryMB = Math.round(process.memoryUsage().heapUsed / (1024 * 1024));
    const startTime = Date.now();

    const detailed = await orchestrator.processLiveBatchDetailed([bench10kPath], (p) =>
      new AmazonMtrLiveAdapter({ sourceReportName: path.basename(p) })
    );

    const durationMs = Date.now() - startTime;
    const endMemoryMB = Math.round(process.memoryUsage().heapUsed / (1024 * 1024));
    const report = detailed.report;

    expect(report.totalRecordsIngested).toBe(10000);
    expect(report.zeroDataLossVerified).toBe(true);

    const sumOutcomes =
      report.outcomes.valid +
      report.outcomes.warning +
      report.outcomes.review +
      report.outcomes.error;
    expect(sumOutcomes).toBe(10000);

    const throughput = durationMs > 0 ? Math.round((10000 / durationMs) * 1000) : 10000;
    expect(throughput).toBeGreaterThan(1000); // End-to-end throughput exceeds 1,000 rec/sec

    console.log(`\n--- Benchmark: 10,000 Records (End-to-End Pipeline) ---`);
    console.log(`Records:    ${report.totalRecordsIngested}`);
    console.log(`Duration:   ${durationMs} ms`);
    console.log(`Throughput: ${throughput} records/sec`);
    console.log(`Heap Delta: ${endMemoryMB - startMemoryMB} MB`);
    console.log(`Outcomes:   VALID=${report.outcomes.valid}, WARN=${report.outcomes.warning}, REV=${report.outcomes.review}, ERR=${report.outcomes.error}`);
  });
});
