import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Building, ArrowRight, ShieldCheck, CheckCircle2, Users } from 'lucide-react';
import { useCurrentOrg } from '../../context/OrgContext';
import { organizationsApi } from '../../api/organizations.api';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Alert } from '../../components/ui/Alert';
import { extractErrorMessage } from '../../utils/errors';
import { PendingInvitationsList } from '../../components/invitations/PendingInvitationsList';

const OrgOnboardingSchema = z.object({
  name: z.string().min(1, 'Organization name is required').max(100),
  pan: z
    .string()
    .trim()
    .toUpperCase()
    .refine((val) => !val || /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(val), {
      message: 'Enter a valid 10-character Indian PAN (e.g. ABCDE1234F)'
    })
    .optional(),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .refine((val) => !val || /^[a-z0-9-]+$/.test(val), {
      message: 'Slug can only contain lowercase letters, numbers, and hyphens'
    })
    .optional()
});

type OrgOnboardingFormValues = z.infer<typeof OrgOnboardingSchema>;

export const OnboardingPage: React.FC = () => {
  const { organizations, reloadOrganizations, setActiveOrgId } = useCurrentOrg();
  const navigate = useNavigate();
  const [apiError, setApiError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting }
  } = useForm<OrgOnboardingFormValues>({
    resolver: zodResolver(OrgOnboardingSchema)
  });

  const onSubmit = async (data: OrgOnboardingFormValues) => {
    setApiError(null);
    try {
      const res = await organizationsApi.createOrganization({
        name: data.name,
        pan: data.pan || undefined,
        slug: data.slug || undefined
      });
      await reloadOrganizations();
      setActiveOrgId(res.organization.id);
      navigate('/gst-registrations');
    } catch (err: unknown) {
      setApiError(extractErrorMessage(err, 'Failed to create organization.'));
    }
  };

  return (
    <div className="min-h-screen bg-[#F5F7FA] flex flex-col justify-center py-12 px-4 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-lg">
        {/* Step indicator */}
        <div className="mb-6 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#EAF0F7] text-[#142B4A] text-xs font-medium mb-3">
            <Building className="w-3.5 h-3.5" />
            <span>Organization Setup</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-[#142B4A]">
            Register your business entity
          </h1>
          <p className="mt-1 text-xs text-slate-500">
            Set up your organization tenant to begin GST registration and MTR reconciliation.
          </p>
        </div>

        {/* Existing organizations card if user already belongs to any */}
        {organizations.length > 0 && (
          <div className="mb-6 p-4 rounded-xl border border-slate-200 bg-white shadow-2xs">
            <div className="text-xs font-semibold text-slate-700 mb-2">
              You already belong to {organizations.length} organization(s):
            </div>
            <div className="space-y-2 mb-3">
              {organizations.map((org) => (
                <div
                  key={org.id}
                  className="flex items-center justify-between p-2.5 rounded-lg border border-slate-100 bg-slate-50 text-xs"
                >
                  <div>
                    <span className="font-semibold text-slate-900">{org.name}</span>
                    <span className="text-slate-400 font-mono ml-2">({org.role})</span>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setActiveOrgId(org.id);
                      navigate('/dashboard');
                    }}
                  >
                    Go to dashboard
                  </Button>
                </div>
              ))}
            </div>
            <div className="text-[11px] text-slate-400 text-center">
              Or create a new organization below:
            </div>
          </div>
        )}

        {/* Pending invitations discovered for user email */}
        <PendingInvitationsList className="mb-6" />

        {/* Join with invitation banner */}
        <div className="mb-6 p-3.5 rounded-xl border border-emerald-200 bg-emerald-50/60 flex items-center justify-between text-xs">
          <div className="flex items-center gap-2.5 text-emerald-950 font-medium">
            <Users className="w-4 h-4 text-[#0F8B72] shrink-0" />
            <span>Have an invitation token from your team?</span>
          </div>
          <Link
            to="/join"
            className="font-semibold text-[#0F8B72] hover:text-[#0B705D] flex items-center gap-1 shrink-0"
          >
            <span>Join organization</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>

        {/* Create Organization Card */}
        <div className="bg-white py-8 px-6 shadow-sm border border-slate-200 rounded-xl sm:px-8">
          {apiError && (
            <Alert type="error" className="mb-5">
              {apiError}
            </Alert>
          )}

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <Input
              label="Legal Organization Name"
              placeholder="e.g. Acme Retail Enterprises Pvt Ltd"
              error={errors.name?.message}
              required
              {...register('name')}
            />

            <Input
              label="Entity Permanent Account Number (PAN)"
              placeholder="e.g. ABCDE1234F"
              isMonospace
              maxLength={10}
              helperText="10-character PAN used to enforce consistency across all state GSTINs"
              error={errors.pan?.message}
              {...register('pan')}
            />

            <Input
              label="Organization URL Slug"
              placeholder="e.g. acme-retail"
              isMonospace
              helperText="Optional identifier used in team invitation links"
              error={errors.slug?.message}
              {...register('slug')}
            />

            <div className="pt-2">
              <Button
                type="submit"
                variant="primary"
                className="w-full"
                isLoading={isSubmitting}
                rightIcon={<ArrowRight className="w-4 h-4" />}
              >
                Create organization & continue
              </Button>
            </div>
          </form>

          <div className="mt-5 pt-4 border-t border-slate-100 space-y-2 text-[11px] text-slate-500">
            <div className="flex items-center gap-1.5 text-slate-600">
              <CheckCircle2 className="w-3.5 h-3.5 text-[#0F8B72]" />
              <span>Full compliance with Section 36 of the CGST Act (72 months data retention)</span>
            </div>
            <div className="flex items-center gap-1.5 text-slate-600">
              <ShieldCheck className="w-3.5 h-3.5 text-[#0F8B72]" />
              <span>Automatic creator assignment as organization Owner</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
