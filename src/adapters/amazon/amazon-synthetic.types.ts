export interface AmazonMtrRawColumns {
  'Seller GSTIN': string;
  'Invoice Number': string;
  'Invoice Date': string;
  'Transaction Type': string;
  'Order ID': string;
  'Shipment ID': string;
  'SKU': string;
  'ASIN': string;
  'HSN/SAC': string;
  'Quantity': string;
  'Product Category': string;
  'Customer Bill To GSTIN': string;
  'Recipient Type': string;
  'Ship From State Code': string;
  'Ship From State': string;
  'Ship To State Code': string;
  'Ship To State': string;
  'Place of Supply State Code': string;
  'Place of Supply': string;
  'Taxable Value': string;
  'Shipping Taxable Value': string;
  'Tax Rate': string;
  'CGST Rate': string;
  'CGST Amount': string;
  'SGST Rate': string;
  'SGST Amount': string;
  'IGST Rate': string;
  'IGST Amount': string;
  'Compensatory Cess Amount': string;
  'Invoice Amount': string;
  'Currency': string;
  'Credit Note Number': string;
  'Credit Note Date': string;
  'Source Report': string;
  'Source Row Number': string;
}

export interface AmazonStockTransferRawColumns {
  'Transfer Invoice Number': string;
  'Transfer Date': string;
  'Source GSTIN': string;
  'Destination GSTIN': string;
  'Ship From State Code': string;
  'Ship From State': string;
  'Ship To State Code': string;
  'Ship To State': string;
  'HSN/SAC': string;
  'Quantity': string;
  'Taxable Value': string;
  'IGST Rate': string;
  'IGST Amount': string;
  'CGST Rate': string;
  'CGST Amount': string;
  'SGST Rate': string;
  'SGST Amount': string;
  'Invoice Amount': string;
  'Transaction Type': string;
  'Source Report': string;
  'Source Row Number': string;
}

export interface AmazonCreditNoteRawColumns {
  'Credit Note Number': string;
  'Credit Note Date': string;
  'Original Invoice Number': string;
  'Original Invoice Date': string;
  'Order ID': string;
  'Recipient Type': string;
  'Seller GSTIN': string;
  'Customer Bill To GSTIN': string;
  'Place of Supply State Code': string;
  'HSN/SAC': string;
  'Taxable Value Reversal': string;
  'CGST Amount Reversal': string;
  'SGST Amount Reversal': string;
  'IGST Amount Reversal': string;
  'Credit Note Total': string;
  'Reason': string;
  'Source Report': string;
  'Source Row Number': string;
}

export interface AmazonEdgeCaseRawColumns extends AmazonMtrRawColumns {
  'Test Case ID'?: string;
  'Expected Issue'?: string;
}
