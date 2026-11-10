import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Users, ArrowRight, ShieldCheck, ArrowLeft, Mail } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useCurrentOrg } from '../../context/OrgContext';
import { invitationsApi } from '../../api/invitations.api';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Alert } from '../../components/ui/Alert';
import { extractErrorMessage } from '../../utils/errors';
import { useToast } from '../../context/ToastContext';
import { PendingInvitationsList } from '../../components/invitations/PendingInvitationsList';

const JoinSchema = z.object({
  token: z.string().min(1, 'Invitation token is required').trim()
});

type JoinFormValues = z.infer<typeof JoinSchema>;

export const JoinOrganizationPage: React.FC = () => {
  const { user } = useAuth();
  const { reloadOrganizations, setActiveOrgId } = useCurrentOrg();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [apiError, setApiError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting }
  } = useForm<JoinFormValues>({
    resolver: zodResolver(JoinSchema)
  });

  // Auto-populate token from query param if available (?token=...)
  useEffect(() => {
    const tokenParam = searchParams.get('token');
    if (tokenParam) {
      setValue('token', tokenParam);
    }
  }, [searchParams, setValue]);

  const onSubmit = async (data: JoinFormValues) => {
    setApiError(null);
    try {
      const res = await invitationsApi.accept(data.token);
      showToast('Successfully joined organization!', 'success');
      await reloadOrganizations();
      if (res.organizationId) {
        setActiveOrgId(res.organizationId);
      }
      navigate('/dashboard');
    } catch (err: unknown) {
      setApiError(
        extractErrorMessage(
          err,
          'Unable to accept invitation. Please ensure the invitation token is valid and matches your account email.'
        )
      );
    }
  };

  return (
    <div className="min-h-screen bg-[#F5F7FA] flex flex-col justify-center py-12 px-4 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-lg">
        {/* Header */}
        <div className="mb-6 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#EAF0F7] text-[#142B4A] text-xs font-medium mb-3">
            <Users className="w-3.5 h-3.5 text-[#0F8B72]" />
            <span>Organization Invitation</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-[#142B4A]">
            Join an existing organization
          </h1>
          <p className="mt-1 text-xs text-slate-500">
            Enter the invitation token sent by your organization administrator.
          </p>
        </div>

        {/* Discovered pending invitations */}
        <PendingInvitationsList className="mb-6" />

        {/* Join Card */}
        <div className="bg-white py-8 px-6 shadow-sm border border-slate-200 rounded-xl sm:px-8">
          {/* User Email Reminder */}
          <div className="mb-5 p-3 rounded-lg bg-slate-50 border border-slate-100 flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 text-slate-600">
              <Mail className="w-4 h-4 text-[#0F8B72]" />
              <span>Joining as: <strong className="text-slate-900">{user?.email}</strong></span>
            </div>
            <span className="text-[11px] text-slate-400 font-mono">Verified</span>
          </div>

          {apiError && (
            <Alert type="error" className="mb-5">
              {apiError}
            </Alert>
          )}

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <Input
              label="Invitation Security Token"
              placeholder="e.g. a1b2c3d4e5f6..."
              isMonospace
              required
              helperText="Paste the token or open the invitation link provided by your organization Owner/Admin"
              error={errors.token?.message}
              {...register('token')}
            />

            <div className="pt-2">
              <Button
                type="submit"
                variant="accent"
                className="w-full"
                isLoading={isSubmitting}
                rightIcon={<ArrowRight className="w-4 h-4" />}
              >
                Accept invitation & join
              </Button>
            </div>
          </form>

          <div className="mt-6 pt-5 border-t border-slate-100 flex items-center justify-between text-xs">
            <Link
              to="/onboarding"
              className="inline-flex items-center gap-1.5 text-slate-500 hover:text-slate-700 transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Create new organization instead</span>
            </Link>

            <Link
              to="/dashboard"
              className="font-medium text-[#0F8B72] hover:text-[#0B705D] transition-colors"
            >
              Go to dashboard
            </Link>
          </div>
        </div>

        <div className="mt-6 flex items-center justify-center gap-1.5 text-slate-400 text-[11px]">
          <ShieldCheck className="w-3.5 h-3.5 text-[#0F8B72]" />
          <span>Statutory invitation tokens are single-use and email-validated</span>
        </div>
      </div>
    </div>
  );
};
