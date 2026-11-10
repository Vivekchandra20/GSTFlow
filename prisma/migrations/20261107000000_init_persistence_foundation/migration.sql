-- CreateEnum
CREATE TYPE "RecipientType" AS ENUM ('B2B', 'B2C', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "SupplyType" AS ENUM ('INTRASTATE', 'INTERSTATE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "RecordType" AS ENUM ('OUTWARD_SUPPLY', 'CREDIT_NOTE', 'STOCK_TRANSFER', 'CANCELLED_ORDER', 'MALFORMED');

-- CreateEnum
CREATE TYPE "PrimaryOutcome" AS ENUM ('VALID', 'WARNING', 'REVIEW', 'ERROR');

-- CreateEnum
CREATE TYPE "StockTransferClassification" AS ENUM ('DISTINCT_PERSON_SUPPLY', 'RELATED_PERSON_SUPPLY', 'INTER_COMPANY_SUPPLY', 'REVIEW_REQUIRED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('MATCHED_FULL', 'MATCHED_PARTIAL', 'UNMATCHED_ORPHAN', 'AMBIGUOUS_MATCH', 'VALUE_EXCEEDED', 'JURISDICTION_MISMATCH');

-- CreateEnum
CREATE TYPE "IssueSeverity" AS ENUM ('ERROR', 'WARNING', 'REVIEW');

-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "FileBatchStatus" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "pan" VARCHAR(10) NOT NULL,
    "data_retention_months" INTEGER NOT NULL DEFAULT 72,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gst_registrations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "gstin" VARCHAR(15) NOT NULL,
    "legal_name" VARCHAR(255) NOT NULL,
    "state_code" VARCHAR(2) NOT NULL,
    "pan" VARCHAR(10) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "gst_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_files" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "file_fingerprint" VARCHAR(64) NOT NULL,
    "file_size_bytes" BIGINT NOT NULL,
    "storage_uri" VARCHAR(500) NOT NULL,
    "report_period" VARCHAR(20),
    "source_report_type" VARCHAR(50) NOT NULL,
    "total_physical_lines" INTEGER NOT NULL DEFAULT 0,
    "uploaded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_batches" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "batch_number" VARCHAR(50) NOT NULL,
    "engine_version" VARCHAR(30) NOT NULL,
    "rules_version" VARCHAR(30) NOT NULL,
    "status" "BatchStatus" NOT NULL DEFAULT 'PENDING',
    "execution_mode" VARCHAR(20) NOT NULL DEFAULT 'STANDARD',
    "reprocess_reason" TEXT,
    "parent_batch_id" UUID,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,
    "total_records_processed" INTEGER NOT NULL DEFAULT 0,
    "configuration" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batch_source_files" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "import_batch_id" UUID NOT NULL,
    "source_file_id" UUID NOT NULL,
    "file_status" "FileBatchStatus" NOT NULL DEFAULT 'QUEUED',
    "processed_lines" INTEGER NOT NULL DEFAULT 0,
    "error_summary" TEXT,

    CONSTRAINT "batch_source_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_records" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "source_file_id" UUID NOT NULL,
    "physical_line_number" INTEGER NOT NULL,
    "logical_record_number" INTEGER NOT NULL,
    "record_type" "RecordType" NOT NULL,
    "raw_payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canonical_invoices" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "seller_gstin" VARCHAR(15) NOT NULL,
    "financial_year" VARCHAR(9) NOT NULL,
    "invoice_number" VARCHAR(50) NOT NULL,
    "invoice_date" DATE NOT NULL,
    "order_id" VARCHAR(100) NOT NULL,
    "recipient_type" "RecipientType" NOT NULL,
    "customer_gstin" VARCHAR(15),
    "ship_from_state_code" VARCHAR(2) NOT NULL,
    "place_of_supply_state_code" VARCHAR(2) NOT NULL,
    "supply_type" "SupplyType" NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'INR',
    "has_legal_hold" BOOLEAN NOT NULL DEFAULT false,
    "legal_proceeding_reference" VARCHAR(255),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "canonical_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canonical_credit_notes" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "seller_gstin" VARCHAR(15) NOT NULL,
    "financial_year" VARCHAR(9) NOT NULL,
    "credit_note_number" VARCHAR(50) NOT NULL,
    "credit_note_date" DATE NOT NULL,
    "original_invoice_number" VARCHAR(50),
    "original_invoice_date" DATE,
    "order_id" VARCHAR(100),
    "recipient_type" "RecipientType" NOT NULL,
    "customer_gstin" VARCHAR(15),
    "place_of_supply_state_code" VARCHAR(2),
    "has_legal_hold" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "canonical_credit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canonical_stock_transfers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "source_gstin" VARCHAR(15) NOT NULL,
    "financial_year" VARCHAR(9) NOT NULL,
    "transfer_invoice_number" VARCHAR(50) NOT NULL,
    "transfer_date" DATE NOT NULL,
    "destination_gstin" VARCHAR(15) NOT NULL,
    "source_pan" VARCHAR(10) NOT NULL,
    "destination_pan" VARCHAR(10) NOT NULL,
    "ship_from_state_code" VARCHAR(2) NOT NULL,
    "ship_to_state_code" VARCHAR(2) NOT NULL,
    "has_legal_hold" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "canonical_stock_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_processing_results" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "import_batch_id" UUID NOT NULL,
    "canonical_invoice_id" UUID NOT NULL,
    "source_record_id" UUID NOT NULL,
    "total_taxable_value" DECIMAL(14,2) NOT NULL,
    "shipping_taxable_value" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "cgst_amount" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "sgst_amount" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "utgst_amount" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "igst_amount" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "cess_amount" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "total_invoice_amount" DECIMAL(14,2) NOT NULL,
    "reported_tcs_cgst" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "reported_tcs_sgst" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "reported_tcs_igst" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "calculated_tcs_cgst" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "calculated_tcs_sgst" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "calculated_tcs_igst" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "cumulative_taxable_reversed" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "cumulative_cgst_reversed" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "cumulative_sgst_reversed" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "cumulative_utgst_reversed" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "cumulative_igst_reversed" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "cumulative_total_reversed" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "reversal_count" INTEGER NOT NULL DEFAULT 0,
    "primary_outcome" "PrimaryOutcome" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_processing_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "invoice_result_id" UUID NOT NULL,
    "source_record_id" UUID NOT NULL,
    "line_number" INTEGER NOT NULL,
    "sku" VARCHAR(100),
    "asin" VARCHAR(20),
    "hsn_sac" VARCHAR(20),
    "product_category" VARCHAR(100),
    "quantity" DECIMAL(12,3) NOT NULL,
    "unit_price" DECIMAL(14,4),
    "item_taxable_value" DECIMAL(14,2) NOT NULL,
    "shipping_taxable_value" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "gift_wrap_taxable_value" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "item_promo_discount" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "tax_rate" DECIMAL(6,4) NOT NULL,
    "cgst_rate" DECIMAL(6,4) NOT NULL DEFAULT 0.00,
    "cgst_amount" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "sgst_rate" DECIMAL(6,4) NOT NULL DEFAULT 0.00,
    "sgst_amount" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "utgst_rate" DECIMAL(6,4) NOT NULL DEFAULT 0.00,
    "utgst_amount" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "igst_rate" DECIMAL(6,4) NOT NULL DEFAULT 0.00,
    "igst_amount" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "cess_amount" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "total_line_amount" DECIMAL(14,2) NOT NULL,
    "amazon_metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_note_processing_results" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "import_batch_id" UUID NOT NULL,
    "canonical_credit_note_id" UUID NOT NULL,
    "source_record_id" UUID NOT NULL,
    "matched_invoice_result_id" UUID,
    "taxable_value_reversal" DECIMAL(14,2) NOT NULL,
    "cgst_amount_reversal" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "sgst_amount_reversal" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "utgst_amount_reversal" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "igst_amount_reversal" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "credit_note_total" DECIMAL(14,2) NOT NULL,
    "raw_signed_amount_text" VARCHAR(50) NOT NULL,
    "signed_amount" DECIMAL(14,2) NOT NULL,
    "reconciliation_status" "ReconciliationStatus" NOT NULL DEFAULT 'UNMATCHED_ORPHAN',
    "primary_outcome" "PrimaryOutcome" NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_note_processing_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfer_processing_results" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "import_batch_id" UUID NOT NULL,
    "canonical_transfer_id" UUID NOT NULL,
    "source_record_id" UUID NOT NULL,
    "classification" "StockTransferClassification" NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "taxable_value" DECIMAL(14,2) NOT NULL,
    "cgst_amount" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "sgst_amount" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "utgst_amount" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "igst_amount" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "cess_amount" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "total_invoice_amount" DECIMAL(14,2) NOT NULL,
    "primary_outcome" "PrimaryOutcome" NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_transfer_processing_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "import_batch_id" UUID NOT NULL,
    "credit_note_result_id" UUID NOT NULL,
    "invoice_result_id" UUID NOT NULL,
    "reconciliation_status" "ReconciliationStatus" NOT NULL,
    "taxable_reversed" DECIMAL(14,2) NOT NULL,
    "cgst_reversed" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "sgst_reversed" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "utgst_reversed" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "igst_reversed" DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    "total_reversed" DECIMAL(14,2) NOT NULL,
    "prior_cumulative_taxable" DECIMAL(14,2) NOT NULL,
    "post_cumulative_taxable" DECIMAL(14,2) NOT NULL,
    "applied_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "validation_issues" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "import_batch_id" UUID NOT NULL,
    "source_record_id" UUID,
    "code" VARCHAR(50) NOT NULL,
    "severity" "IssueSeverity" NOT NULL,
    "field" VARCHAR(100),
    "message" TEXT NOT NULL,
    "suggested_action" TEXT,
    "document_id" VARCHAR(100),
    "source_report" VARCHAR(255) NOT NULL,
    "source_row_number" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "validation_issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processing_metrics" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "import_batch_id" UUID NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "records_per_second" INTEGER NOT NULL,
    "start_memory_heap_used_mb" INTEGER NOT NULL,
    "peak_memory_heap_used_mb" INTEGER NOT NULL,
    "total_records_ingested" INTEGER NOT NULL,
    "valid_outcomes" INTEGER NOT NULL,
    "warning_outcomes" INTEGER NOT NULL,
    "review_outcomes" INTEGER NOT NULL,
    "error_outcomes" INTEGER NOT NULL,
    "zero_data_loss_verified" BOOLEAN NOT NULL,
    "aggregate_taxable_turnover" DECIMAL(16,2) NOT NULL,
    "aggregate_tax_collected" DECIMAL(16,2) NOT NULL,
    "aggregate_tax_reversed" DECIMAL(16,2) NOT NULL,
    "total_credit_notes" INTEGER NOT NULL,
    "matched_full" INTEGER NOT NULL,
    "matched_partial" INTEGER NOT NULL,
    "unmatched_orphan" INTEGER NOT NULL,
    "ambiguous_matches" INTEGER NOT NULL,
    "value_exceeded" INTEGER NOT NULL,
    "jurisdiction_mismatch" INTEGER NOT NULL,
    "matched_b2b" INTEGER NOT NULL,
    "matched_b2c" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processing_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gst_registrations_pan_idx" ON "gst_registrations"("pan");

-- CreateIndex
CREATE INDEX "gst_registrations_state_code_idx" ON "gst_registrations"("state_code");

-- CreateIndex
CREATE UNIQUE INDEX "gst_registrations_organization_id_id_key" ON "gst_registrations"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "gst_registrations_organization_id_gstin_key" ON "gst_registrations"("organization_id", "gstin");

-- CreateIndex
CREATE UNIQUE INDEX "source_files_organization_id_id_key" ON "source_files"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "source_files_organization_id_file_fingerprint_key" ON "source_files"("organization_id", "file_fingerprint");

-- CreateIndex
CREATE INDEX "import_batches_organization_id_status_idx" ON "import_batches"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "import_batches_organization_id_id_key" ON "import_batches"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "import_batches_organization_id_batch_number_key" ON "import_batches"("organization_id", "batch_number");

-- CreateIndex
CREATE UNIQUE INDEX "batch_source_files_import_batch_id_source_file_id_key" ON "batch_source_files"("import_batch_id", "source_file_id");

-- CreateIndex
CREATE INDEX "source_records_organization_id_record_type_idx" ON "source_records"("organization_id", "record_type");

-- CreateIndex
CREATE UNIQUE INDEX "source_records_organization_id_id_key" ON "source_records"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "source_records_source_file_id_physical_line_number_key" ON "source_records"("source_file_id", "physical_line_number");

-- CreateIndex
CREATE INDEX "canonical_invoices_seller_gstin_invoice_number_financial_ye_idx" ON "canonical_invoices"("seller_gstin", "invoice_number", "financial_year");

-- CreateIndex
CREATE UNIQUE INDEX "canonical_invoices_organization_id_id_key" ON "canonical_invoices"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "canonical_invoices_organization_id_seller_gstin_financial_y_key" ON "canonical_invoices"("organization_id", "seller_gstin", "financial_year", "invoice_number");

-- CreateIndex
CREATE INDEX "canonical_credit_notes_seller_gstin_original_invoice_number_idx" ON "canonical_credit_notes"("seller_gstin", "original_invoice_number");

-- CreateIndex
CREATE UNIQUE INDEX "canonical_credit_notes_organization_id_id_key" ON "canonical_credit_notes"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "canonical_credit_notes_organization_id_seller_gstin_financi_key" ON "canonical_credit_notes"("organization_id", "seller_gstin", "financial_year", "credit_note_number");

-- CreateIndex
CREATE UNIQUE INDEX "canonical_stock_transfers_organization_id_id_key" ON "canonical_stock_transfers"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "canonical_stock_transfers_organization_id_source_gstin_fina_key" ON "canonical_stock_transfers"("organization_id", "source_gstin", "financial_year", "transfer_invoice_number");

-- CreateIndex
CREATE INDEX "invoice_processing_results_organization_id_primary_outcome_idx" ON "invoice_processing_results"("organization_id", "primary_outcome");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_processing_results_organization_id_id_key" ON "invoice_processing_results"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_processing_results_import_batch_id_canonical_invoic_key" ON "invoice_processing_results"("import_batch_id", "canonical_invoice_id");

-- CreateIndex
CREATE INDEX "invoice_lines_sku_idx" ON "invoice_lines"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_lines_invoice_result_id_line_number_key" ON "invoice_lines"("invoice_result_id", "line_number");

-- CreateIndex
CREATE INDEX "credit_note_processing_results_organization_id_reconciliati_idx" ON "credit_note_processing_results"("organization_id", "reconciliation_status");

-- CreateIndex
CREATE UNIQUE INDEX "credit_note_processing_results_organization_id_id_key" ON "credit_note_processing_results"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_note_processing_results_import_batch_id_canonical_cr_key" ON "credit_note_processing_results"("import_batch_id", "canonical_credit_note_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfer_processing_results_organization_id_id_key" ON "stock_transfer_processing_results"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfer_processing_results_import_batch_id_canonical_key" ON "stock_transfer_processing_results"("import_batch_id", "canonical_transfer_id");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliations_credit_note_result_id_key" ON "reconciliations"("credit_note_result_id");

-- CreateIndex
CREATE INDEX "reconciliations_organization_id_invoice_result_id_idx" ON "reconciliations"("organization_id", "invoice_result_id");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliations_organization_id_credit_note_result_id_key" ON "reconciliations"("organization_id", "credit_note_result_id");

-- CreateIndex
CREATE INDEX "validation_issues_organization_id_import_batch_id_severity_idx" ON "validation_issues"("organization_id", "import_batch_id", "severity");

-- CreateIndex
CREATE INDEX "validation_issues_code_idx" ON "validation_issues"("code");

-- CreateIndex
CREATE UNIQUE INDEX "processing_metrics_import_batch_id_key" ON "processing_metrics"("import_batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "processing_metrics_organization_id_import_batch_id_key" ON "processing_metrics"("organization_id", "import_batch_id");

-- AddForeignKey
ALTER TABLE "gst_registrations" ADD CONSTRAINT "gst_registrations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_files" ADD CONSTRAINT "source_files_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_parent_batch_id_fkey" FOREIGN KEY ("parent_batch_id") REFERENCES "import_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_source_files" ADD CONSTRAINT "batch_source_files_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_source_files" ADD CONSTRAINT "batch_source_files_organization_id_import_batch_id_fkey" FOREIGN KEY ("organization_id", "import_batch_id") REFERENCES "import_batches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_source_files" ADD CONSTRAINT "batch_source_files_organization_id_source_file_id_fkey" FOREIGN KEY ("organization_id", "source_file_id") REFERENCES "source_files"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_organization_id_source_file_id_fkey" FOREIGN KEY ("organization_id", "source_file_id") REFERENCES "source_files"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_invoices" ADD CONSTRAINT "canonical_invoices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_credit_notes" ADD CONSTRAINT "canonical_credit_notes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_stock_transfers" ADD CONSTRAINT "canonical_stock_transfers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_processing_results" ADD CONSTRAINT "invoice_processing_results_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_processing_results" ADD CONSTRAINT "invoice_processing_results_organization_id_import_batch_id_fkey" FOREIGN KEY ("organization_id", "import_batch_id") REFERENCES "import_batches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_processing_results" ADD CONSTRAINT "invoice_processing_results_organization_id_canonical_invoi_fkey" FOREIGN KEY ("organization_id", "canonical_invoice_id") REFERENCES "canonical_invoices"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_processing_results" ADD CONSTRAINT "invoice_processing_results_organization_id_source_record_i_fkey" FOREIGN KEY ("organization_id", "source_record_id") REFERENCES "source_records"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_organization_id_invoice_result_id_fkey" FOREIGN KEY ("organization_id", "invoice_result_id") REFERENCES "invoice_processing_results"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_organization_id_source_record_id_fkey" FOREIGN KEY ("organization_id", "source_record_id") REFERENCES "source_records"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_processing_results" ADD CONSTRAINT "credit_note_processing_results_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_processing_results" ADD CONSTRAINT "credit_note_processing_results_organization_id_import_batc_fkey" FOREIGN KEY ("organization_id", "import_batch_id") REFERENCES "import_batches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_processing_results" ADD CONSTRAINT "credit_note_processing_results_organization_id_canonical_c_fkey" FOREIGN KEY ("organization_id", "canonical_credit_note_id") REFERENCES "canonical_credit_notes"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_processing_results" ADD CONSTRAINT "credit_note_processing_results_organization_id_source_reco_fkey" FOREIGN KEY ("organization_id", "source_record_id") REFERENCES "source_records"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_processing_results" ADD CONSTRAINT "credit_note_processing_results_organization_id_matched_inv_fkey" FOREIGN KEY ("organization_id", "matched_invoice_result_id") REFERENCES "invoice_processing_results"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_processing_results" ADD CONSTRAINT "stock_transfer_processing_results_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_processing_results" ADD CONSTRAINT "stock_transfer_processing_results_organization_id_import_b_fkey" FOREIGN KEY ("organization_id", "import_batch_id") REFERENCES "import_batches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_processing_results" ADD CONSTRAINT "stock_transfer_processing_results_organization_id_canonica_fkey" FOREIGN KEY ("organization_id", "canonical_transfer_id") REFERENCES "canonical_stock_transfers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_processing_results" ADD CONSTRAINT "stock_transfer_processing_results_organization_id_source_r_fkey" FOREIGN KEY ("organization_id", "source_record_id") REFERENCES "source_records"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_organization_id_import_batch_id_fkey" FOREIGN KEY ("organization_id", "import_batch_id") REFERENCES "import_batches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_organization_id_credit_note_result_id_fkey" FOREIGN KEY ("organization_id", "credit_note_result_id") REFERENCES "credit_note_processing_results"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_organization_id_invoice_result_id_fkey" FOREIGN KEY ("organization_id", "invoice_result_id") REFERENCES "invoice_processing_results"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_issues" ADD CONSTRAINT "validation_issues_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_issues" ADD CONSTRAINT "validation_issues_organization_id_import_batch_id_fkey" FOREIGN KEY ("organization_id", "import_batch_id") REFERENCES "import_batches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_issues" ADD CONSTRAINT "validation_issues_organization_id_source_record_id_fkey" FOREIGN KEY ("organization_id", "source_record_id") REFERENCES "source_records"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processing_metrics" ADD CONSTRAINT "processing_metrics_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processing_metrics" ADD CONSTRAINT "processing_metrics_organization_id_import_batch_id_fkey" FOREIGN KEY ("organization_id", "import_batch_id") REFERENCES "import_batches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;



-- ==========================================
-- ROW LEVEL SECURITY (RLS) & TENANT POLICIES
-- ==========================================

-- Enable and Force RLS on all tenant-accessible tables
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gst_registrations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_files" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import_batches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "batch_source_files" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "canonical_invoices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "canonical_credit_notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "canonical_stock_transfers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice_processing_results" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "credit_note_processing_results" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_transfer_processing_results" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reconciliations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "validation_issues" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "processing_metrics" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "organizations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "gst_registrations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "source_files" FORCE ROW LEVEL SECURITY;
ALTER TABLE "import_batches" FORCE ROW LEVEL SECURITY;
ALTER TABLE "batch_source_files" FORCE ROW LEVEL SECURITY;
ALTER TABLE "source_records" FORCE ROW LEVEL SECURITY;
ALTER TABLE "canonical_invoices" FORCE ROW LEVEL SECURITY;
ALTER TABLE "canonical_credit_notes" FORCE ROW LEVEL SECURITY;
ALTER TABLE "canonical_stock_transfers" FORCE ROW LEVEL SECURITY;
ALTER TABLE "invoice_processing_results" FORCE ROW LEVEL SECURITY;
ALTER TABLE "invoice_lines" FORCE ROW LEVEL SECURITY;
ALTER TABLE "credit_note_processing_results" FORCE ROW LEVEL SECURITY;
ALTER TABLE "stock_transfer_processing_results" FORCE ROW LEVEL SECURITY;
ALTER TABLE "reconciliations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "validation_issues" FORCE ROW LEVEL SECURITY;
ALTER TABLE "processing_metrics" FORCE ROW LEVEL SECURITY;

-- Tenant Isolation Policies
CREATE POLICY "org_isolation_organizations" ON "organizations"
  FOR ALL USING ("id" = NULLIF(current_setting('app.current_organization_id', true), '')::UUID);

CREATE POLICY "org_isolation_gst_registrations" ON "gst_registrations"
  FOR ALL USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::UUID);

CREATE POLICY "org_isolation_source_files" ON "source_files"
  FOR ALL USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::UUID);

CREATE POLICY "org_isolation_import_batches" ON "import_batches"
  FOR ALL USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::UUID);

CREATE POLICY "org_isolation_batch_source_files" ON "batch_source_files"
  FOR ALL USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::UUID);

CREATE POLICY "org_isolation_source_records" ON "source_records"
  FOR ALL USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::UUID);

CREATE POLICY "org_isolation_canonical_invoices" ON "canonical_invoices"
  FOR ALL USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::UUID);

CREATE POLICY "org_isolation_canonical_credit_notes" ON "canonical_credit_notes"
  FOR ALL USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::UUID);

CREATE POLICY "org_isolation_canonical_stock_transfers" ON "canonical_stock_transfers"
  FOR ALL USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::UUID);

CREATE POLICY "org_isolation_invoice_processing_results" ON "invoice_processing_results"
  FOR ALL USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::UUID);

CREATE POLICY "org_isolation_invoice_lines" ON "invoice_lines"
  FOR ALL USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::UUID);

CREATE POLICY "org_isolation_credit_note_processing_results" ON "credit_note_processing_results"
  FOR ALL USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::UUID);

CREATE POLICY "org_isolation_stock_transfer_processing_results" ON "stock_transfer_processing_results"
  FOR ALL USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::UUID);

CREATE POLICY "org_isolation_reconciliations" ON "reconciliations"
  FOR ALL USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::UUID);

CREATE POLICY "org_isolation_validation_issues" ON "validation_issues"
  FOR ALL USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::UUID);

CREATE POLICY "org_isolation_processing_metrics" ON "processing_metrics"
  FOR ALL USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::UUID);

-- ==========================================
-- APPLICATION ROLE CONFIGURATION
-- ==========================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'gstflow_app') THEN
    CREATE ROLE gstflow_app WITH LOGIN PASSWORD 'gstflow_app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  ELSE
    ALTER ROLE gstflow_app NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO gstflow_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gstflow_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gstflow_app;
