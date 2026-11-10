-- ==============================================================================
-- Migration: 20261109020000_phase4_2_4_gst_registration_lifecycle
-- Description: Phase 4.2.4 — GST Registration Lifecycle, Statuses & RLS Check
-- ==============================================================================

-- CreateEnum: GstRegistrationStatus
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'GstRegistrationStatus') THEN
    CREATE TYPE "GstRegistrationStatus" AS ENUM ('ACTIVE', 'CANCELLED', 'SUSPENDED', 'INACTIVE');
  END IF;
END $$;

-- CreateEnum: GstRegistrationType
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'GstRegistrationType') THEN
    CREATE TYPE "GstRegistrationType" AS ENUM ('REGULAR', 'COMPOSITION', 'ISD', 'CASUAL', 'NON_RESIDENT', 'TCS_ECO', 'TDS', 'OIDAR');
  END IF;
END $$;

-- AlterTable: gst_registrations
ALTER TABLE "gst_registrations" 
  ADD COLUMN IF NOT EXISTS "trade_name" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "registration_type" "GstRegistrationType" NOT NULL DEFAULT 'REGULAR',
  ADD COLUMN IF NOT EXISTS "status" "GstRegistrationStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS "effective_date" DATE,
  ADD COLUMN IF NOT EXISTS "cancellation_date" DATE;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_gst_registrations_org_status" 
  ON "gst_registrations"("organization_id", "status");

-- Strengthen RLS policy with explicit WITH CHECK
DROP POLICY IF EXISTS "org_isolation_gst_registrations" ON "gst_registrations";
CREATE POLICY "org_isolation_gst_registrations" ON "gst_registrations"
  FOR ALL TO gstflow_app
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::UUID)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::UUID);

-- Role Grants
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'gstflow_app') THEN
    GRANT USAGE ON TYPE "GstRegistrationStatus" TO gstflow_app;
    GRANT USAGE ON TYPE "GstRegistrationType" TO gstflow_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "gst_registrations" TO gstflow_app;
  END IF;

  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'gstflow_definer') THEN
    GRANT USAGE ON TYPE "GstRegistrationStatus" TO gstflow_definer;
    GRANT USAGE ON TYPE "GstRegistrationType" TO gstflow_definer;
    GRANT SELECT ON TABLE "gst_registrations" TO gstflow_definer;
  END IF;
END $$;
