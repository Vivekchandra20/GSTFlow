import fs from 'node:fs';
import { parse } from 'csv-parse';
import { MarketplaceAdapter, RawMarketplaceRecord, ReportType } from '../base.adapter.js';

export class AmazonSyntheticAdapter implements MarketplaceAdapter {
  /**
   * Infer ReportType from CSV headers or filename.
   */
  public inferReportType(headers: string[], filePath?: string): ReportType {
    const headerSet = new Set(headers.map((h) => h.trim()));

    if (headerSet.has('Transfer Invoice Number') || headerSet.has('Source GSTIN')) {
      return 'STOCK_TRANSFER';
    }
    if (headerSet.has('Credit Note Total') || headerSet.has('Original Invoice Number')) {
      return 'CREDIT_NOTE';
    }
    if (headerSet.has('Expected Issue') || headerSet.has('Test Case ID')) {
      return 'EDGE_CASES';
    }
    if (filePath) {
      const lower = filePath.toLowerCase();
      if (lower.includes('b2b')) return 'B2B';
      if (lower.includes('b2c')) return 'B2C';
      if (lower.includes('stock_transfer') || lower.includes('stock transfer')) return 'STOCK_TRANSFER';
      if (lower.includes('credit_notes') || lower.includes('credit notes')) return 'CREDIT_NOTE';
      if (lower.includes('invalid') || lower.includes('edge')) return 'EDGE_CASES';
    }
    return 'UNKNOWN';
  }

  /**
   * Stream raw records from a CSV file using csv-parse with guaranteed resource cleanup.
   * Yields RawMarketplaceRecord objects with line numbers and raw string values.
   */
  public async *streamRecords(
    filePath: string,
    defaultReportType?: ReportType
  ): AsyncIterable<RawMarketplaceRecord> {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });

    const parser = fileStream.pipe(
      parse({
        columns: true,
        skip_empty_lines: true,
        trim: false,
        relax_column_count: true,
        relax_quotes: true,
        info: true
      })
    );

    let dataRowIndex = 0;
    let inferredType: ReportType = defaultReportType || 'UNKNOWN';

    try {
      for await (const chunk of parser) {
        const { record, info } = chunk as {
          record: Record<string, string>;
          info: { lines: number; records: number; columns?: any[]; error?: Error };
        };
        dataRowIndex++;
        const physicalLine = info.lines;

        if (dataRowIndex === 1 && inferredType === 'UNKNOWN') {
          inferredType = this.inferReportType(Object.keys(record), filePath);
        }

        // Preserve embedded source report or fall back to inferred name
        const sourceReport =
          record['Source Report']?.trim() ||
          (inferredType !== 'UNKNOWN' ? `SYNTHETIC_AMAZON_${inferredType}` : 'SYNTHETIC_AMAZON');

        // Preserve embedded source row number if present; fallback to physical line
        let sourceRowNumber = physicalLine;
        if (record['Source Row Number']) {
          const parsedSourceRow = parseInt(record['Source Row Number'].trim(), 10);
          if (!isNaN(parsedSourceRow)) {
            sourceRowNumber = parsedSourceRow;
          }
        }

        // Check for parsing anomalies
        const parseErrors: string[] = [];
        if (info.error) {
          parseErrors.push(info.error.message);
        }
        if (info.columns && Object.keys(record).length !== info.columns.length) {
          parseErrors.push(
            `Column count mismatch: expected ${info.columns.length}, found ${Object.keys(record).length}`
          );
        }

        const rawRecord: RawMarketplaceRecord = {
          sourceReport,
          sourceRowNumber,
          physicalLineNumber: physicalLine,
          reportType: inferredType,
          rawFields: record,
          parseErrors: parseErrors.length > 0 ? parseErrors : undefined
        };

        yield rawRecord;
      }
    } finally {
      // Guaranteed resource destruction on normal completion, stream error, or early loop break
      if (!fileStream.destroyed) {
        fileStream.destroy();
      }
      if (!parser.destroyed) {
        parser.destroy();
      }
    }
  }

  /**
   * Parse entire CSV file into an array of RawMarketplaceRecord.
   */
  public async parseFile(
    filePath: string,
    defaultReportType?: ReportType
  ): Promise<RawMarketplaceRecord[]> {
    const records: RawMarketplaceRecord[] = [];
    for await (const record of this.streamRecords(filePath, defaultReportType)) {
      records.push(record);
    }
    return records;
  }
}

export const defaultAmazonAdapter = new AmazonSyntheticAdapter();
