-- Phase 4.2.2: User Identity & Authentication Infrastructure
-- Migration: 20261109000000_phase4_2_2_user_authentication

-- 1. Create UserStatus Enum
DO $$ BEGIN
    CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- 2. Create Users Table
CREATE TABLE IF NOT EXISTS "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" VARCHAR(255) NOT NULL,
    "normalized_email" VARCHAR(255) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "email_verified_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- Unique index for case-insensitive normalized email
CREATE UNIQUE INDEX IF NOT EXISTS "users_normalized_email_key" ON "users"("normalized_email");
CREATE INDEX IF NOT EXISTS "idx_users_status" ON "users"("status");

-- 3. Create RefreshSessions Table
CREATE TABLE IF NOT EXISTS "refresh_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "token_family_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,
    "replaced_by_session_id" UUID,
    "user_agent" VARCHAR(500),
    "ip_address" VARCHAR(45),
    "last_used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "refresh_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Indexes for RefreshSessions
CREATE UNIQUE INDEX IF NOT EXISTS "refresh_sessions_token_hash_key" ON "refresh_sessions"("token_hash");
CREATE INDEX IF NOT EXISTS "idx_refresh_sessions_family" ON "refresh_sessions"("token_family_id");
CREATE INDEX IF NOT EXISTS "idx_refresh_sessions_user_exp" ON "refresh_sessions"("user_id", "expires_at");

-- 4. Grant Permissions to Application Role (gstflow_app)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.users TO gstflow_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.refresh_sessions TO gstflow_app;
