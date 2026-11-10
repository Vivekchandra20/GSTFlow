export type ReportType =
  | 'B2B'
  | 'B2C'
  | 'STOCK_TRANSFER'
  | 'CREDIT_NOTE'
  | 'EDGE_CASES'
  | 'UNKNOWN';

export interface RawMarketplaceRecord {
  sourceReport: string;
  sourceRowNumber: number;        // Preserved from file if available, or 1-based data row index
  physicalLineNumber: number;     // Physical CSV file line number
  reportType: ReportType;
  rawFields: Record<string, string>;
  parseErrors?: string[];
}

export interface MarketplaceAdapter {
  streamRecords(filePath: string, defaultReportType?: ReportType): AsyncIterable<RawMarketplaceRecord>;
  parseFile(filePath: string, defaultReportType?: ReportType): Promise<RawMarketplaceRecord[]>;
}
