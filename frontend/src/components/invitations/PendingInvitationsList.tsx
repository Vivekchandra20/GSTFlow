import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Mail, Check, X, Building, Clock, ShieldCheck } from 'lucide-react';
import { invitationsApi } from '../../api/invitations.api';
import { PendingInvitation } from '../../api/types';
import { useCurrentOrg } from '../../context/OrgContext';
import { useToast } from '../../context/ToastContext';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { formatDate } from '../../utils/dates';
import { extractErrorMessage } from '../../utils/errors';

interface PendingInvitationsListProps {
  className?: string;
  onAccepted?: (orgId: string) => void;
}

export const PendingInvitationsList: React.FC<PendingInvitationsListProps> = ({
  className = '',
  onAccepted
}) => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { reloadOrganizations, setActiveOrgId } = useCurrentOrg();
  const { showToast } = useToast();

  const [processingId, setProcessingId] = useState<string | null>(null);
  const [actionType, setActionType] = useState<'accept' | 'decline' | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['pending-invitations'],
    queryFn: () => invitationsApi.listPending()
  });

  const invitations = data?.invitations || [];

  if (isLoading || invitations.length === 0) {
    return null;
  }

  const handleAccept = async (invitation: PendingInvitation) => {
    setProcessingId(invitation.id);
    setActionType('accept');
    try {
      const res = await invitationsApi.accept({ invitationId: invitation.id });
      showToast(`Joined ${invitation.organizationName} successfully!`, 'success');
      await queryClient.invalidateQueries({ queryKey: ['pending-invitations'] });
      await reloadOrganizations();
      if (res.organizationId) {
        setActiveOrgId(res.organizationId);
      }
      if (onAccepted) {
        onAccepted(res.organizationId);
      } else {
        navigate('/dashboard');
      }
    } catch (err: unknown) {
      showToast(extractErrorMessage(err, 'Failed to accept invitation.'), 'error');
    } finally {
      setProcessingId(null);
      setActionType(null);
    }
  };

  const handleDecline = async (invitation: PendingInvitation) => {
    setProcessingId(invitation.id);
    setActionType('decline');
    try {
      await invitationsApi.decline(invitation.id);
      showToast(`Declined invitation from ${invitation.organizationName}.`, 'info');
      await queryClient.invalidateQueries({ queryKey: ['pending-invitations'] });
    } catch (err: unknown) {
      showToast(extractErrorMessage(err, 'Failed to decline invitation.'), 'error');
    } finally {
      setProcessingId(null);
      setActionType(null);
    }
  };

  return (
    <div className={`p-4 rounded-xl border border-blue-200 bg-blue-50/70 shadow-2xs ${className}`}>
      <div className="flex items-center gap-2 mb-3 text-xs font-semibold text-[#142B4A]">
        <Mail className="w-4 h-4 text-[#0F8B72]" />
        <span>Pending Organization Invitations ({invitations.length})</span>
      </div>

      <div className="space-y-3">
        {invitations.map((inv) => {
          const isBusy = processingId === inv.id;
          return (
            <div
              key={inv.id}
              className="p-3.5 rounded-lg border border-slate-200 bg-white shadow-2xs flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
            >
              <div className="space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-slate-900 text-sm flex items-center gap-1.5">
                    <Building className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    {inv.organizationName}
                  </span>
                  <Badge variant="info">{inv.role}</Badge>
                </div>

                <div className="flex items-center gap-3 text-slate-500 text-[11px] flex-wrap">
                  {inv.invitedByEmail && (
                    <span>
                      Invited by <strong className="text-slate-700">{inv.invitedByEmail}</strong>
                    </span>
                  )}
                  <span className="flex items-center gap-1">
                    <Clock className="w-3 h-3 text-slate-400" />
                    Expires {formatDate(inv.expiresAt)}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2 self-end sm:self-auto shrink-0">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isBusy}
                  isLoading={isBusy && actionType === 'decline'}
                  leftIcon={<X className="w-3.5 h-3.5" />}
                  onClick={() => handleDecline(inv)}
                >
                  Decline
                </Button>
                <Button
                  size="sm"
                  variant="accent"
                  disabled={isBusy}
                  isLoading={isBusy && actionType === 'accept'}
                  leftIcon={<Check className="w-3.5 h-3.5" />}
                  onClick={() => handleAccept(inv)}
                >
                  Accept & Join
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex items-center gap-1.5 text-[11px] text-slate-500">
        <ShieldCheck className="w-3.5 h-3.5 text-[#0F8B72]" />
        <span>Invitations are automatically linked to your authenticated email address.</span>
      </div>
    </div>
  );
};
