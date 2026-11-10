import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { OrganizationDetails, OrganizationRole, UserOrganization } from '../api/types';
import { organizationsApi } from '../api/organizations.api';
import { useAuth } from './AuthContext';

interface OrgContextValue {
  organizations: UserOrganization[];
  activeOrg: UserOrganization | null;
  activeOrgDetails: OrganizationDetails | null;
  isLoadingOrgs: boolean;
  setActiveOrgId: (orgId: string) => void;
  reloadOrganizations: () => Promise<void>;
  role: OrganizationRole | null;
  isOwner: boolean;
  isAdminOrOwner: boolean;
  canManageGstin: boolean;
  canUpload: boolean;
  canManageMembers: boolean;
}

const OrgContext = createContext<OrgContextValue | undefined>(undefined);

const ACTIVE_ORG_STORAGE_KEY = 'gstflow_active_org_id';

export const OrgProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated } = useAuth();
  const [organizations, setOrganizations] = useState<UserOrganization[]>([]);
  const [activeOrgId, setActiveOrgIdState] = useState<string | null>(() => {
    return localStorage.getItem(ACTIVE_ORG_STORAGE_KEY);
  });
  const [activeOrgDetails, setActiveOrgDetails] = useState<OrganizationDetails | null>(null);
  const [isLoadingOrgs, setIsLoadingOrgs] = useState<boolean>(true);

  const reloadOrganizations = useCallback(async () => {
    if (!isAuthenticated) {
      setOrganizations([]);
      setActiveOrgDetails(null);
      setIsLoadingOrgs(false);
      return;
    }

    try {
      setIsLoadingOrgs(true);
      const res = await organizationsApi.listUserOrganizations();
      const orgs = res.organizations || [];
      setOrganizations(orgs);

      // Select active org
      if (orgs.length > 0) {
        let selected = orgs.find((o) => o.id === activeOrgId);
        if (!selected) {
          selected = orgs[0];
          setActiveOrgIdState(selected.id);
          localStorage.setItem(ACTIVE_ORG_STORAGE_KEY, selected.id);
        }
      } else {
        setActiveOrgIdState(null);
        localStorage.removeItem(ACTIVE_ORG_STORAGE_KEY);
      }
    } catch {
      setOrganizations([]);
    } finally {
      setIsLoadingOrgs(false);
    }
  }, [isAuthenticated, activeOrgId]);

  useEffect(() => {
    reloadOrganizations();
  }, [reloadOrganizations]);

  // Load detailed organization metadata when activeOrg changes
  useEffect(() => {
    if (!activeOrgId || !isAuthenticated) {
      setActiveOrgDetails(null);
      return;
    }

    let isMounted = true;
    organizationsApi
      .getOrganization(activeOrgId)
      .then((details) => {
        if (isMounted) setActiveOrgDetails(details);
      })
      .catch(() => {
        if (isMounted) setActiveOrgDetails(null);
      });

    return () => {
      isMounted = false;
    };
  }, [activeOrgId, isAuthenticated]);

  const setActiveOrgId = useCallback((orgId: string) => {
    setActiveOrgIdState(orgId);
    localStorage.setItem(ACTIVE_ORG_STORAGE_KEY, orgId);
  }, []);

  const activeOrg = useMemo(() => {
    if (!activeOrgId) return null;
    return organizations.find((o) => o.id === activeOrgId) || null;
  }, [organizations, activeOrgId]);

  const role = activeOrg?.role || null;
  const isOwner = role === 'OWNER';
  const isAdminOrOwner = role === 'OWNER' || role === 'ADMIN';
  const canManageGstin = isAdminOrOwner;
  const canUpload = role === 'OWNER' || role === 'ADMIN' || role === 'MEMBER';
  const canManageMembers = isAdminOrOwner;

  return (
    <OrgContext.Provider
      value={{
        organizations,
        activeOrg,
        activeOrgDetails,
        isLoadingOrgs,
        setActiveOrgId,
        reloadOrganizations,
        role,
        isOwner,
        isAdminOrOwner,
        canManageGstin,
        canUpload,
        canManageMembers
      }}
    >
      {children}
    </OrgContext.Provider>
  );
};

export function useCurrentOrg(): OrgContextValue {
  const context = useContext(OrgContext);
  if (!context) {
    throw new Error('useCurrentOrg must be used within an OrgProvider');
  }
  return context;
}
