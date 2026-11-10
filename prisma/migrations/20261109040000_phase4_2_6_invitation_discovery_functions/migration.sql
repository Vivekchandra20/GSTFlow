-- Migration: Add resolve_invitation_by_id and list_pending_invitations_by_email helper functions

CREATE OR REPLACE FUNCTION resolve_invitation_by_id(p_invitation_id uuid)
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
    WHERE i.id = p_invitation_id;
END;
$$;

CREATE OR REPLACE FUNCTION list_pending_invitations_by_email(p_normalized_email varchar)
RETURNS TABLE (
    invitation_id uuid,
    organization_id uuid,
    organization_name varchar(200),
    organization_slug varchar(255),
    email varchar(255),
    role "MembershipRole",
    invited_by_user_id uuid,
    invited_by_email varchar(255),
    expires_at timestamptz,
    created_at timestamptz
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
        i.role,
        i.invited_by_user_id,
        u.email,
        i.expires_at,
        i.created_at
    FROM public.organization_invitations i
    JOIN public.organizations o ON o.id = i.organization_id
    LEFT JOIN public.users u ON u.id = i.invited_by_user_id
    WHERE i.normalized_email = LOWER(TRIM(p_normalized_email))
      AND i.accepted_at IS NULL
      AND i.revoked_at IS NULL
      AND i.expires_at > CURRENT_TIMESTAMP
    ORDER BY i.created_at DESC;
END;
$$;

-- Configure ownership and execution grants
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gstflow_definer') THEN
        ALTER FUNCTION resolve_invitation_by_id(uuid) OWNER TO gstflow_definer;
        ALTER FUNCTION list_pending_invitations_by_email(varchar) OWNER TO gstflow_definer;
    END IF;
END $$;

REVOKE ALL ON FUNCTION resolve_invitation_by_id(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION list_pending_invitations_by_email(varchar) FROM PUBLIC;

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gstflow_app') THEN
        GRANT EXECUTE ON FUNCTION resolve_invitation_by_id(uuid) TO gstflow_app;
        GRANT EXECUTE ON FUNCTION list_pending_invitations_by_email(varchar) TO gstflow_app;
    END IF;
END $$;
