-- ========================================================
-- GSTFLOW PHASE 4.1 MIGRATION: ASYNCHRONOUS JOB & OUTBOX
-- ========================================================

-- 1. Create Enums
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'CLAIMED', 'PUBLISHED', 'FAILED');
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'PROCESSING', 'RETRYING', 'COMPLETED', 'FAILED', 'CANCELLED');
CREATE TYPE "ExecutionCheckpoint" AS ENUM ('STAGING', 'DOMAIN_PROCESSING', 'CANONICAL_PERSISTENCE', 'CREDIT_NOTE_RECONCILIATION', 'COMPLETED');
CREATE TYPE "BatchExecutionMode" AS ENUM ('INGESTION', 'REPROCESSING');

-- 2. Create outbox_events table
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "event_type" VARCHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "claimed_by" VARCHAR(128),
    "lease_expires_at" TIMESTAMPTZ,
    "published_at" TIMESTAMPTZ,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "outbox_events_org_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "idx_outbox_claim" ON "outbox_events"("status", "lease_expires_at", "created_at");
CREATE INDEX "idx_outbox_org" ON "outbox_events"("organization_id");

-- 3. Create processing_jobs table
CREATE TABLE "processing_jobs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "import_batch_id" UUID NOT NULL,
    "job_type" VARCHAR(64) NOT NULL DEFAULT 'BATCH_PROCESSING',
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "execution_checkpoint" "ExecutionCheckpoint" NOT NULL DEFAULT 'STAGING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "bullmq_job_id" VARCHAR(128),
    "execution_mode" "BatchExecutionMode" NOT NULL DEFAULT 'INGESTION',
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "failed_at" TIMESTAMPTZ,
    "last_error" TEXT,
    "error_stack" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "processing_jobs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "processing_jobs_org_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "processing_jobs_batch_fk" FOREIGN KEY ("organization_id", "import_batch_id") REFERENCES "import_batches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "idx_jobs_org_status" ON "processing_jobs"("organization_id", "status");
CREATE INDEX "idx_jobs_batch" ON "processing_jobs"("import_batch_id");
CREATE INDEX "idx_jobs_bullmq_id" ON "processing_jobs"("bullmq_job_id");

-- 4. Enable Row Level Security
ALTER TABLE "outbox_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation_outbox_events" ON "outbox_events"
  FOR ALL USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::UUID);

ALTER TABLE "processing_jobs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation_processing_jobs" ON "processing_jobs"
  FOR ALL USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::UUID);

-- 5. Dedicated Restricted NOLOGIN Role for SECURITY DEFINER Functions
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gstflow_definer') THEN
    CREATE ROLE gstflow_definer WITH NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON "outbox_events" TO gstflow_definer;
GRANT SELECT, INSERT, UPDATE, DELETE ON "processing_jobs" TO gstflow_definer;

-- Explicit RLS policy granting gstflow_definer access to outbox_events and processing_jobs without global BYPASSRLS
CREATE POLICY "definer_access_outbox_events" ON "outbox_events"
  TO gstflow_definer
  USING (true)
  WITH CHECK (true);

CREATE POLICY "definer_access_processing_jobs" ON "processing_jobs"
  TO gstflow_definer
  USING (true)
  WITH CHECK (true);

-- 6. Restricted SECURITY DEFINER functions for background workers / dispatchers
-- Claim outbox events atomically with FOR UPDATE SKIP LOCKED
CREATE OR REPLACE FUNCTION claim_outbox_events(
  p_claimed_by text,
  p_batch_size integer,
  p_lease_seconds integer
)
RETURNS TABLE (
  id uuid,
  organization_id uuid,
  event_type varchar(64),
  payload jsonb,
  attempts integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_batch_size integer;
  v_lease_seconds integer;
BEGIN
  -- Strict input validation
  IF p_claimed_by IS NULL OR length(trim(p_claimed_by)) = 0 OR length(p_claimed_by) > 128 THEN
    RAISE EXCEPTION 'Invalid dispatcher identifier: must be non-empty and at most 128 characters';
  END IF;

  v_batch_size := GREATEST(1, LEAST(COALESCE(p_batch_size, 50), 500));
  v_lease_seconds := GREATEST(1, LEAST(COALESCE(p_lease_seconds, 30), 3600));

  RETURN QUERY
  WITH eligible AS (
    SELECT e.id
    FROM public.outbox_events e
    WHERE e.status = 'PENDING'
       OR (e.status = 'CLAIMED' AND e.lease_expires_at < CURRENT_TIMESTAMP)
    ORDER BY e.created_at ASC
    LIMIT v_batch_size
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.outbox_events e
  SET status = 'CLAIMED',
      claimed_by = p_claimed_by,
      lease_expires_at = CURRENT_TIMESTAMP + (v_lease_seconds || ' seconds')::interval,
      attempts = e.attempts + 1,
      updated_at = CURRENT_TIMESTAMP
  FROM eligible
  WHERE e.id = eligible.id
  RETURNING e.id, e.organization_id, e.event_type, e.payload, e.attempts;
END;
$$;

-- Authoritative job lookup bypassing RLS only for single job ID resolution
CREATE OR REPLACE FUNCTION resolve_processing_job(
  p_job_id uuid
)
RETURNS TABLE (
  id uuid,
  organization_id uuid,
  import_batch_id uuid,
  job_type varchar(64),
  status text,
  execution_checkpoint text,
  attempts integer,
  max_attempts integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_job_id IS NULL THEN
    RAISE EXCEPTION 'Job ID must not be null';
  END IF;

  RETURN QUERY
  SELECT 
    j.id,
    j.organization_id,
    j.import_batch_id,
    j.job_type,
    j.status::text,
    j.execution_checkpoint::text,
    j.attempts,
    j.max_attempts
  FROM public.processing_jobs j
  WHERE j.id = p_job_id;
END;
$$;

-- Mark outbox event published with strict dispatcher claim and lease validation
CREATE OR REPLACE FUNCTION mark_outbox_published(
  p_event_id uuid,
  p_claimed_by text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_rows_affected integer;
BEGIN
  IF p_event_id IS NULL THEN
    RAISE EXCEPTION 'Event ID must not be null';
  END IF;

  IF p_claimed_by IS NULL OR length(trim(p_claimed_by)) = 0 OR length(p_claimed_by) > 128 THEN
    RAISE EXCEPTION 'Invalid dispatcher identifier: must be non-empty and at most 128 characters';
  END IF;

  UPDATE public.outbox_events
  SET status = 'PUBLISHED',
      published_at = CURRENT_TIMESTAMP,
      lease_expires_at = NULL,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = p_event_id
    AND status = 'CLAIMED'
    AND claimed_by = p_claimed_by
    AND lease_expires_at >= CURRENT_TIMESTAMP;

  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
  RETURN v_rows_affected > 0;
END;
$$;

-- Fail outbox event or reset to PENDING if attempts remain, with strict dispatcher claim validation
CREATE OR REPLACE FUNCTION fail_outbox_event(
  p_event_id uuid,
  p_claimed_by text,
  p_error text,
  p_max_attempts integer DEFAULT 5
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_rows_affected integer;
  v_max_attempts integer;
BEGIN
  IF p_event_id IS NULL THEN
    RAISE EXCEPTION 'Event ID must not be null';
  END IF;

  IF p_claimed_by IS NULL OR length(trim(p_claimed_by)) = 0 OR length(p_claimed_by) > 128 THEN
    RAISE EXCEPTION 'Invalid dispatcher identifier: must be non-empty and at most 128 characters';
  END IF;

  v_max_attempts := GREATEST(1, LEAST(COALESCE(p_max_attempts, 5), 50));

  UPDATE public.outbox_events
  SET status = CASE WHEN attempts >= v_max_attempts THEN 'FAILED'::"OutboxStatus" ELSE 'PENDING'::"OutboxStatus" END,
      lease_expires_at = NULL,
      claimed_by = NULL,
      last_error = substring(COALESCE(p_error, 'Unknown error') from 1 for 4096),
      updated_at = CURRENT_TIMESTAMP
  WHERE id = p_event_id
    AND status = 'CLAIMED'
    AND claimed_by = p_claimed_by
    AND lease_expires_at >= CURRENT_TIMESTAMP;

  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
  RETURN v_rows_affected > 0;
END;
$$;

-- 7. Assign Function Ownership to Dedicated NOLOGIN Role
ALTER FUNCTION claim_outbox_events(text, integer, integer) OWNER TO gstflow_definer;
ALTER FUNCTION resolve_processing_job(uuid) OWNER TO gstflow_definer;
ALTER FUNCTION mark_outbox_published(uuid, text) OWNER TO gstflow_definer;
ALTER FUNCTION fail_outbox_event(uuid, text, text, integer) OWNER TO gstflow_definer;

-- 8. Explicit Permissions Configuration
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM gstflow_app;
REVOKE CREATE ON SCHEMA public FROM gstflow_definer;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM gstflow_definer;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.outbox_events TO gstflow_definer;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.processing_jobs TO gstflow_definer;

REVOKE ALL ON FUNCTION claim_outbox_events(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_processing_job(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION mark_outbox_published(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION fail_outbox_event(uuid, text, text, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION claim_outbox_events(text, integer, integer) TO gstflow_app;
GRANT EXECUTE ON FUNCTION resolve_processing_job(uuid) TO gstflow_app;
GRANT EXECUTE ON FUNCTION mark_outbox_published(uuid, text) TO gstflow_app;
GRANT EXECUTE ON FUNCTION fail_outbox_event(uuid, text, text, integer) TO gstflow_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON "outbox_events" TO gstflow_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "processing_jobs" TO gstflow_app;
