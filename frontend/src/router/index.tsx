import React from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useCurrentOrg } from '../context/OrgContext';
import { AppShell } from '../components/layout/AppShell';
import { LoginPage } from '../pages/auth/LoginPage';
import { RegisterPage } from '../pages/auth/RegisterPage';
import { OnboardingPage } from '../pages/onboarding/OnboardingPage';
import { JoinOrganizationPage } from '../pages/onboarding/JoinOrganizationPage';
import { DashboardPage } from '../pages/dashboard/DashboardPage';
import { GstRegistrationsPage } from '../pages/gst-registrations/GstRegistrationsPage';
import { ImportCenterPage } from '../pages/imports/ImportCenterPage';
import { ImportHistoryPage } from '../pages/imports/ImportHistoryPage';
import { ImportDetailsPage } from '../pages/imports/ImportDetailsPage';
import { ReconciliationPage } from '../pages/reconciliation/ReconciliationPage';
import { DiscrepancyPage } from '../pages/reconciliation/DiscrepancyPage';
import { TeamManagementPage } from '../pages/team/TeamManagementPage';
import { SettingsPage } from '../pages/settings/SettingsPage';
import { Skeleton } from '../components/ui/Skeleton';

// Auth Guard: Requires user to be logged in
const RequireAuth: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#F5F7FA] flex flex-col items-center justify-center p-4">
        <div className="w-12 h-12 rounded-xl bg-[#142B4A] text-[#0F8B72] text-xl font-bold flex items-center justify-center mb-4 animate-pulse">
          GF
        </div>
        <Skeleton className="h-4 w-36 mb-2" />
        <Skeleton className="h-3 w-48" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
};

// Org Guard: Ensures user has an active organization or redirects to /onboarding
const RequireOrg: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { organizations, isLoadingOrgs } = useCurrentOrg();

  if (isLoadingOrgs) {
    return (
      <div className="min-h-screen bg-[#F5F7FA] flex flex-col items-center justify-center p-4">
        <Skeleton className="h-8 w-48 mb-3" />
        <Skeleton className="h-4 w-64" />
      </div>
    );
  }

  if (organizations.length === 0) {
    return <Navigate to="/onboarding" replace />;
  }

  return <>{children}</>;
};

// Public Only Guard: Redirects authenticated users to /dashboard
const PublicOnly: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#F5F7FA] flex items-center justify-center">
        <Skeleton className="h-8 w-32" />
      </div>
    );
  }

  if (isAuthenticated) {
    return <Navigate to="/dashboard" replace />;
  }

  return <>{children}</>;
};

export const AppRouter: React.FC = () => {
  return (
    <Routes>
      {/* Public Routes */}
      <Route
        path="/login"
        element={
          <PublicOnly>
            <LoginPage />
          </PublicOnly>
        }
      />
      <Route
        path="/register"
        element={
          <PublicOnly>
            <RegisterPage />
          </PublicOnly>
        }
      />

      {/* Onboarding & Join Routes */}
      <Route
        path="/onboarding"
        element={
          <RequireAuth>
            <OnboardingPage />
          </RequireAuth>
        }
      />
      <Route
        path="/join"
        element={
          <RequireAuth>
            <JoinOrganizationPage />
          </RequireAuth>
        }
      />

      {/* Protected App Routes */}
      <Route
        path="/"
        element={
          <RequireAuth>
            <RequireOrg>
              <AppShell />
            </RequireOrg>
          </RequireAuth>
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="gst-registrations" element={<GstRegistrationsPage />} />
        <Route path="imports" element={<ImportHistoryPage />} />
        <Route path="imports/new" element={<ImportCenterPage />} />
        <Route path="imports/:batchId" element={<ImportDetailsPage />} />
        <Route path="reconciliation" element={<ReconciliationPage />} />
        <Route path="reconciliation/discrepancies" element={<DiscrepancyPage />} />
        <Route path="settings/members" element={<TeamManagementPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>

      {/* Catch-all */}
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
};
