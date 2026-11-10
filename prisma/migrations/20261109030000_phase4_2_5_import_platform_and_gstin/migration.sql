-- ==============================================================================
-- Migration: 20261109030000_phase4_2_5_import_platform_and_gstin
-- Description: Phase 4.2.5 — Source Platform Enum, GST Registration Association & Import Batch Link
-- ==============================================================================

-- CreateEnum: SourcePlatform
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SourcePlatform') THEN
    CREATE TYPE "SourcePlatform" AS ENUM ('AMAZON', 'FLIPKART', 'MEESHO', 'CUSTOM');
  END IF;
END $$;

-- AlterTable: import_batches
ALTER TABLE "import_batches"
  ADD COLUMN IF NOT EXISTS "gst_registration_id" UUID,
  ADD COLUMN IF NOT EXISTS "source_platform" "SourcePlatform" NOT NULL DEFAULT 'AMAZON';

-- AddForeignKey: import_batches -> gst_registrations
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_import_batches_gst_registration'
  ) THEN
    ALTER TABLE "import_batches"
      ADD CONSTRAINT "fk_import_batches_gst_registration"
      FOREIGN KEY ("organization_id", "gst_registration_id")
      REFERENCES "gst_registrations"("organization_id", "id")
      ON DELETE RESTRICT;
  END IF;
END $$;

-- CreateIndex: idx_import_batches_org_gstin
CREATE INDEX IF NOT EXISTS "idx_import_batches_org_gstin"
  ON "import_batches"("organization_id", "gst_registration_id");

-- Role Grants
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'gstflow_app') THEN
    GRANT USAGE ON TYPE "SourcePlatform" TO gstflow_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "import_batches" TO gstflow_app;
  END IF;

  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'gstflow_definer') THEN
    GRANT USAGE ON TYPE "SourcePlatform" TO gstflow_definer;
    GRANT SELECT, UPDATE ON TABLE "import_batches" TO gstflow_definer;
  END IF;
END $$;
