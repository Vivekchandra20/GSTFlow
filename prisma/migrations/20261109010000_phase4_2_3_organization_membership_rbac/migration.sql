-- Phase 4.2.3: Organization Management, Membership, RBAC & Tenant Authorization
-- Migration: 20261109010000_phase4_2_3_organization_membership_rbac

-- 1. Create Enums
DO $$ BEGIN
    CREATE TYPE "OrganizationStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE "MembershipRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'SUSPENDED');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- 2. Alter organizations table
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "slug" VARCHAR(255);
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "status" "OrganizationStatus" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "organizations" ALTER COLUMN "pan" DROP NOT NULL;

-- Backfill slugs for any pre-existing rows
UPDATE "organizations" 
SET "slug" = 'org-' || SUBSTRING("id"::text, 1, 8)
WHERE "slug" IS NULL;

ALTER TABLE "organizations" ALTER COLUMN "slug" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_slug_key" ON "organizations"("slug");
CREATE INDEX IF NOT EXISTS "idx_organizations_status" ON "organizations"("status");

-- 3. Create organization_memberships table
CREATE TABLE IF NOT EXISTS "organization_memberships" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "MembershipRole" NOT NULL DEFAULT 'MEMBER',
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "joined_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_memberships_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "organization_memberships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "organization_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "uq_org_membership_user" UNIQUE ("organization_id", "user_id")
);

CREATE INDEX IF NOT EXISTS "idx_memberships_user_status" ON "organization_memberships"("user_id", "status");
CREATE INDEX IF NOT EXISTS "idx_memberships_org_role" ON "organization_memberships"("organization_id", "role");
CREATE INDEX IF NOT EXISTS "idx_memberships_org_status" ON "organization_memberships"("organization_id", "status");

-- 4. Create organization_invitations table
CREATE TABLE IF NOT EXISTS "organization_invitations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "normalized_email" VARCHAR(255) NOT NULL,
    "role" "MembershipRole" NOT NULL DEFAULT 'MEMBER',
    "token_hash" VARCHAR(64) NOT NULL,
    "invited_by_user_id" UUID,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "accepted_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_invitations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "organization_invitations_token_hash_key" UNIQUE ("token_hash"),
    CONSTRAINT "organization_invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "organization_invitations_invited_by_user_id_fkey" FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "idx_invitations_org_email" ON "organization_invitations"("organization_id", "normalized_email");
CREATE INDEX IF NOT EXISTS "idx_invitations_org_exp" ON "organization_invitations"("organization_id", "expires_at");

-- 5. Row-Level Security on memberships and invitations
ALTER TABLE "organization_memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_memberships" FORCE ROW LEVEL SECURITY;

ALTER TABLE "organization_invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_invitations" FORCE ROW LEVEL SECURITY;

-- Tenant RLS Policies for application role
CREATE POLICY "org_isolation_memberships" ON "organization_memberships"
    FOR ALL TO gstflow_app
    USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::UUID)
    WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::UUID);

CREATE POLICY "org_isolation_invitations" ON "organization_invitations"
    FOR ALL TO gstflow_app
    USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::UUID)
    WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::UUID);

-- Definer access policies for internal helper functions
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gstflow_definer') THEN
        CREATE POLICY "definer_access_organizations" ON "organizations"
            TO gstflow_definer USING (true) WITH CHECK (true);

        CREATE POLICY "definer_access_memberships" ON "organization_memberships"
            TO gstflow_definer USING (true) WITH CHECK (true);

        CREATE POLICY "definer_access_invitations" ON "organization_invitations"
            TO gstflow_definer USING (true) WITH CHECK (true);
    END IF;
END $$;

-- 6. Role Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON "organization_memberships" TO gstflow_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "organization_invitations" TO gstflow_app;

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gstflow_definer') THEN
        GRANT SELECT ON "organizations" TO gstflow_definer;
        GRANT SELECT, INSERT, UPDATE, DELETE ON "organization_memberships" TO gstflow_definer;
        GRANT SELECT, INSERT, UPDATE, DELETE ON "organization_invitations" TO gstflow_definer;
    END IF;
END $$;

-- 7. SECURITY DEFINER Functions for pre-tenant resolution
CREATE OR REPLACE FUNCTION list_user_organizations(p_user_id uuid)
RETURNS TABLE (
    organization_id uuid,
    organization_name varchar(200),
    organization_slug varchar(255),
    organization_status "OrganizationStatus",
    membership_id uuid,
    membership_role "MembershipRole",
    membership_status "MembershipStatus",
    joined_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        o.id,
        o.name,
        o.slug,
        o.status,
        m.id,
        m.role,
        m.status,
        m.joined_at
    FROM public.organizations o
    JOIN public.organization_memberships m ON m.organization_id = o.id
    WHERE m.user_id = p_user_id AND m.status = 'ACTIVE' AND o.status = 'ACTIVE'
    ORDER BY m.created_at ASC;
END;
$$;

CREATE OR REPLACE FUNCTION get_user_membership(p_user_id uuid, p_organization_id uuid)
RETURNS TABLE (
    membership_id uuid,
    organization_id uuid,
    organization_name varchar(200),
    organization_slug varchar(255),
    organization_status "OrganizationStatus",
    user_id uuid,
    membership_role "MembershipRole",
    membership_status "MembershipStatus"
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        m.id,
        m.organization_id,
        o.name,
        o.slug,
        o.status,
        m.user_id,
        m.role,
        m.status
    FROM public.organization_memberships m
    JOIN public.organizations o ON o.id = m.organization_id
    WHERE m.user_id = p_user_id AND m.organization_id = p_organization_id;
END;
$$;

CREATE OR REPLACE FUNCTION resolve_invitation_by_token_hash(p_token_hash varchar)
RETURNS TABLE (
    invitation_id uuid,
    organization_id uuid,
    organization_name varchar(200),
    organization_slug varchar(255),
    email varchar(255),
    normalized_email varchar(255),
    role "MembershipRole",
    expires_at timestamptz,
    accepted_at timestamptz,
    revoked_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        i.id,
        i.organization_id,
        o.name,
        o.slug,
        i.email,
        i.normalized_email,
        i.role,
        i.expires_at,
        i.accepted_at,
        i.revoked_at
    FROM public.organization_invitations i
    JOIN public.organizations o ON o.id = i.organization_id
    WHERE i.token_hash = p_token_hash;
END;
$$;

-- Configure ownership and execution grants
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gstflow_definer') THEN
        ALTER FUNCTION list_user_organizations(uuid) OWNER TO gstflow_definer;
        ALTER FUNCTION get_user_membership(uuid, uuid) OWNER TO gstflow_definer;
        ALTER FUNCTION resolve_invitation_by_token_hash(varchar) OWNER TO gstflow_definer;
    END IF;
END $$;

REVOKE ALL ON FUNCTION list_user_organizations(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION get_user_membership(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_invitation_by_token_hash(varchar) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION list_user_organizations(uuid) TO gstflow_app;
GRANT EXECUTE ON FUNCTION get_user_membership(uuid, uuid) TO gstflow_app;
GRANT EXECUTE ON FUNCTION resolve_invitation_by_token_hash(varchar) TO gstflow_app;
