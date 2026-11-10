import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  Building,
  User,
  Shield,
  LogOut,
  AlertTriangle
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useCurrentOrg } from '../../context/OrgContext';
import { organizationsApi } from '../../api/organizations.api';
import { PageHeader } from '../../components/layout/PageHeader';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Alert } from '../../components/ui/Alert';
import { Modal } from '../../components/ui/Modal';
import { extractErrorMessage } from '../../utils/errors';
import { useToast } from '../../context/ToastContext';

const UpdateOrgSchema = z.object({
  name: z.string().min(1, 'Organization name is required').max(100),
  pan: z
    .string()
    .trim()
    .toUpperCase()
    .refine((val) => !val || /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(val), {
      message: 'Enter a valid 10-character Indian PAN'
    })
    .optional()
});

type UpdateOrgFormValues = z.infer<typeof UpdateOrgSchema>;

export const SettingsPage: React.FC = () => {
  const { user, logout } = useAuth();
  const { activeOrg, activeOrgDetails, isOwner, reloadOrganizations } = useCurrentOrg();
  const { showToast } = useToast();
  const navigate = useNavigate();

  const [apiError, setApiError] = useState<string | null>(null);
  const [isLeaveModalOpen, setIsLeaveModalOpen] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting, isDirty }
  } = useForm<UpdateOrgFormValues>({
    resolver: zodResolver(UpdateOrgSchema),
    values: {
      name: activeOrgDetails?.name || activeOrg?.name || '',
      pan: activeOrgDetails?.pan || ''
    }
  });

  const onSubmit = async (data: UpdateOrgFormValues) => {
    if (!activeOrg || !isOwner) return;
    setApiError(null);
    try {
      await organizationsApi.updateOrganization(activeOrg.id, {
        name: data.name,
        pan: data.pan || undefined
      });
      await reloadOrganizations();
      showToast('Organization settings updated', 'success');
    } catch (err: unknown) {
      setApiError(extractErrorMessage(err, 'Failed to update organization.'));
    }
  };

  const handleLeaveOrg = async () => {
    if (!activeOrg) return;
    setIsLeaving(true);
    try {
      await organizationsApi.leaveOrganization(activeOrg.id);
      showToast('You have left the organization', 'info');
      await reloadOrganizations();
      navigate('/dashboard');
    } catch (err: unknown) {
      showToast(extractErrorMessage(err, 'Unable to leave organization.'), 'error');
    } finally {
      setIsLeaving(false);
      setIsLeaveModalOpen(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <PageHeader
        title="Settings & Entity Preferences"
        description="Configure entity details, review statutory data retention policies, and manage your account."
      />

      {apiError && <Alert type="error">{apiError}</Alert>}

      {/* Organization Profile Settings */}
      <div className="p-5 rounded-lg border border-slate-200 bg-white shadow-2xs space-y-4">
        <div className="flex items-center gap-2 pb-3 border-b border-slate-100">
          <Building className="w-4 h-4 text-[#142B4A]" />
          <h3 className="text-sm font-semibold text-slate-900">Organization Profile</h3>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <Input
            label="Organization Legal Name"
            placeholder="Acme Retail Private Limited"
            disabled={!isOwner}
            error={errors.name?.message}
            required
            {...register('name')}
          />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Entity PAN"
              placeholder="ABCDE1234F"
              isMonospace
              maxLength={10}
              disabled={!isOwner}
              error={errors.pan?.message}
              {...register('pan')}
            />

            <div>
              <label className="text-xs font-medium text-slate-700 block mb-1.5">
                Organization Identifier (Slug)
              </label>
              <input
                readOnly
                disabled
                value={activeOrgDetails?.slug || activeOrg?.slug || ''}
                className="w-full rounded-md border border-slate-200 py-2 px-3 text-xs bg-slate-50 font-mono text-slate-500 cursor-not-allowed"
              />
              <span className="text-[11px] text-slate-400 mt-1 block">
                Immutable tenant routing identifier.
              </span>
            </div>
          </div>

          {isOwner && (
            <div className="pt-2 flex justify-end">
              <Button type="submit" variant="primary" isLoading={isSubmitting} disabled={!isDirty}>
                Save changes
              </Button>
            </div>
          )}
        </form>
      </div>

      {/* Statutory Data Retention & Compliance Proviso */}
      <div className="p-5 rounded-lg border border-slate-200 bg-white shadow-2xs space-y-3">
        <div className="flex items-center gap-2 pb-3 border-b border-slate-100">
          <Shield className="w-4 h-4 text-[#0F8B72]" />
          <h3 className="text-sm font-semibold text-slate-900">Statutory Compliance & Retention</h3>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
          <div className="p-3 rounded-lg bg-slate-50 border border-slate-100">
            <div className="text-slate-500 font-medium">Statutory Data Retention Policy</div>
            <div className="text-base font-bold text-slate-900 font-mono mt-1">
              72 Months (6 Years)
            </div>
            <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">
              Mandatory minimum retention from the due date of GSTR-9 under Section 36 of the CGST Act.
            </p>
          </div>

          <div className="p-3 rounded-lg bg-slate-50 border border-slate-100">
            <div className="text-slate-500 font-medium">Tenant Security & RLS</div>
            <div className="text-base font-bold text-[#0F8B72] font-mono mt-1">Enforced</div>
            <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">
              All financial rows are bounded to organization ID with PostgreSQL Row-Level Security.
            </p>
          </div>
        </div>
      </div>

      {/* User Account Section */}
      <div className="p-5 rounded-lg border border-slate-200 bg-white shadow-2xs space-y-4">
        <div className="flex items-center gap-2 pb-3 border-b border-slate-100">
          <User className="w-4 h-4 text-[#142B4A]" />
          <h3 className="text-sm font-semibold text-slate-900">Your Account</h3>
        </div>

        <div className="flex items-center justify-between text-xs py-1">
          <div>
            <div className="text-slate-500">Authenticated Email</div>
            <div className="font-semibold text-slate-900 text-sm mt-0.5">{user?.email}</div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="text-red-600 border-red-200 hover:bg-red-50"
            leftIcon={<LogOut className="w-3.5 h-3.5" />}
            onClick={handleLogout}
          >
            Sign out
          </Button>
        </div>
      </div>

      {/* Danger Zone: Leave Organization */}
      {!isOwner && activeOrg && (
        <div className="p-5 rounded-lg border border-red-200 bg-red-50/30 shadow-2xs space-y-3">
          <div className="flex items-center gap-2 text-red-900">
            <AlertTriangle className="w-4 h-4" />
            <h3 className="text-sm font-semibold">Leave Organization</h3>
          </div>
          <p className="text-xs text-red-700 leading-relaxed">
            Revoke your membership and access to this organization. You will no longer be able to
            inspect reconciliations or upload source reports until re-invited.
          </p>
          <Button
            variant="danger"
            size="sm"
            onClick={() => setIsLeaveModalOpen(true)}
          >
            Leave this organization
          </Button>
        </div>
      )}

      {/* Confirm Leave Modal */}
      <Modal
        isOpen={isLeaveModalOpen}
        onClose={() => setIsLeaveModalOpen(false)}
        title="Leave Organization"
        description={`Are you sure you want to leave ${activeOrg?.name}?`}
        maxWidth="sm"
        footer={
          <>
            <Button variant="outline" size="sm" onClick={() => setIsLeaveModalOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              isLoading={isLeaving}
              onClick={handleLeaveOrg}
            >
              Yes, leave organization
            </Button>
          </>
        }
      >
        <p className="text-xs text-slate-600 leading-relaxed">
          You will lose all access to this organization's GSTIN filings, uploaded MTR files, and
          reconciliation reports.
        </p>
      </Modal>
    </div>
  );
};
