import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Modal } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { Alert } from '../../components/ui/Alert';
import { invitationsApi } from '../../api/invitations.api';
import { extractErrorMessage } from '../../utils/errors';
import { OrganizationRole } from '../../api/types';
import { Copy, Check } from 'lucide-react';

const InviteMemberSchema = z.object({
  email: z.string().min(1, 'Email is required').email('Enter a valid email address'),
  role: z.enum(['ADMIN', 'MEMBER', 'VIEWER'])
});

type InviteMemberFormValues = z.infer<typeof InviteMemberSchema>;

export interface InviteMemberModalProps {
  isOpen: boolean;
  onClose: () => void;
  organizationId: string;
  onSuccess: () => void;
}

export const InviteMemberModal: React.FC<InviteMemberModalProps> = ({
  isOpen,
  onClose,
  organizationId,
  onSuccess
}) => {
  const [apiError, setApiError] = useState<string | null>(null);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting }
  } = useForm<InviteMemberFormValues>({
    resolver: zodResolver(InviteMemberSchema),
    defaultValues: {
      role: 'MEMBER'
    }
  });

  const onSubmit = async (data: InviteMemberFormValues) => {
    setApiError(null);
    try {
      const res = await invitationsApi.create(organizationId, {
        email: data.email,
        role: data.role as OrganizationRole
      });
      setCreatedToken(res.invitationToken);
      onSuccess();
    } catch (err: unknown) {
      setApiError(extractErrorMessage(err, 'Failed to send invitation.'));
    }
  };

  const handleClose = () => {
    reset();
    setCreatedToken(null);
    setCopiedToken(false);
    setCopiedLink(false);
    onClose();
  };

  const joinLink = createdToken ? `${window.location.origin}/join?token=${createdToken}` : '';

  const copyToken = () => {
    if (createdToken) {
      navigator.clipboard.writeText(createdToken);
      setCopiedToken(true);
      setTimeout(() => setCopiedToken(false), 2000);
    }
  };

  const copyLink = () => {
    if (joinLink) {
      navigator.clipboard.writeText(joinLink);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Invite Team Member"
      description="Invite a colleague or accountant to collaborate on reconciliation within this organization."
      maxWidth="md"
    >
      {createdToken ? (
        <div className="space-y-4">
          <Alert type="success" title="Invitation Created">
            Share this invitation link or token with your team member. When they open the link or enter the token, they will automatically join this organization.
          </Alert>

          <div>
            <label className="text-xs font-medium text-slate-700 block mb-1">
              One-Click Invitation Link
            </label>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={joinLink}
                className="w-full text-xs font-mono bg-slate-50 border border-slate-200 rounded p-2 text-slate-800"
              />
              <Button size="sm" variant="accent" onClick={copyLink}>
                {copiedLink ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                <span className="hidden sm:inline ml-1">{copiedLink ? 'Copied' : 'Copy link'}</span>
              </Button>
            </div>
            <p className="text-[11px] text-slate-500 mt-1">Recipient can simply open this URL to join directly.</p>
          </div>

          <div>
            <label className="text-xs font-medium text-slate-700 block mb-1">
              Raw Security Token
            </label>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={createdToken}
                className="w-full text-xs font-mono bg-slate-50 border border-slate-200 rounded p-2 text-slate-800"
              />
              <Button size="sm" variant="outline" onClick={copyToken}>
                {copiedToken ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
                <span className="hidden sm:inline ml-1">{copiedToken ? 'Copied' : 'Copy token'}</span>
              </Button>
            </div>
            <p className="text-[11px] text-slate-500 mt-1">Valid for 7 days. Can be entered at <strong>/join</strong>.</p>
          </div>

          <div className="pt-2 flex justify-end">
            <Button variant="primary" onClick={handleClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {apiError && <Alert type="error">{apiError}</Alert>}

          <Input
            label="Work Email Address"
            type="email"
            placeholder="colleague@company.com"
            required
            error={errors.email?.message}
            {...register('email')}
          />

          <Select
            label="Assigned Role"
            options={[
              { value: 'ADMIN', label: 'Admin (Manage GSTINs, Members & Uploads)' },
              { value: 'MEMBER', label: 'Member (Upload reports & view reconciliations)' },
              { value: 'VIEWER', label: 'Viewer (Read-only access)' }
            ]}
            error={errors.role?.message}
            {...register('role')}
          />

          <div className="pt-4 flex items-center justify-end gap-2 border-t border-slate-100">
            <Button type="button" variant="outline" onClick={handleClose}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" isLoading={isSubmitting}>
              Generate invitation
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
};
