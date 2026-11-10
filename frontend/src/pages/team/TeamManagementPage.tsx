import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Users,
  UserPlus,
  Mail,
  Trash2
} from 'lucide-react';
import { useCurrentOrg } from '../../context/OrgContext';
import { organizationsApi } from '../../api/organizations.api';
import { invitationsApi } from '../../api/invitations.api';
import { PageHeader } from '../../components/layout/PageHeader';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { TableSkeleton } from '../../components/ui/Skeleton';
import { InviteMemberModal } from './InviteMemberModal';
import { formatDate } from '../../utils/dates';
import { OrganizationMember, OrganizationRole } from '../../api/types';
import { useToast } from '../../context/ToastContext';

export const TeamManagementPage: React.FC = () => {
  const { activeOrg, canManageMembers, isOwner } = useCurrentOrg();
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);

  // Load members
  const { data: membersData, isLoading: isLoadingMembers } = useQuery({
    queryKey: ['org-members', activeOrg?.id],
    queryFn: () => (activeOrg ? organizationsApi.listMembers(activeOrg.id) : null),
    enabled: !!activeOrg?.id
  });

  // Load pending invitations
  const { data: invitationsData, isLoading: isLoadingInvites } = useQuery({
    queryKey: ['org-invitations', activeOrg?.id],
    queryFn: () => (activeOrg ? invitationsApi.list(activeOrg.id) : null),
    enabled: !!activeOrg?.id && canManageMembers
  });

  const members = membersData?.members || [];
  const invitations = invitationsData?.invitations || [];

  // Update member role mutation
  const updateRoleMutation = useMutation({
    mutationFn: async ({
      userId,
      newRole
    }: {
      userId: string;
      newRole: OrganizationRole;
    }) => {
      if (!activeOrg) throw new Error('No active organization');
      return organizationsApi.updateMemberRole(activeOrg.id, userId, newRole);
    },
    onSuccess: () => {
      showToast('Member role updated successfully', 'success');
      queryClient.invalidateQueries({ queryKey: ['org-members', activeOrg?.id] });
    },
    onError: (err: any) => {
      showToast(err?.message || 'Failed to update member role', 'error');
    }
  });

  // Remove member mutation
  const removeMemberMutation = useMutation({
    mutationFn: async (userId: string) => {
      if (!activeOrg) throw new Error('No active organization');
      return organizationsApi.removeMember(activeOrg.id, userId);
    },
    onSuccess: () => {
      showToast('Member removed from organization', 'success');
      queryClient.invalidateQueries({ queryKey: ['org-members', activeOrg?.id] });
    },
    onError: (err: any) => {
      showToast(err?.message || 'Failed to remove member', 'error');
    }
  });

  // Revoke invitation mutation
  const revokeInviteMutation = useMutation({
    mutationFn: async (invitationId: string) => {
      if (!activeOrg) throw new Error('No active organization');
      return invitationsApi.revoke(activeOrg.id, invitationId);
    },
    onSuccess: () => {
      showToast('Invitation revoked', 'success');
      queryClient.invalidateQueries({ queryKey: ['org-invitations', activeOrg?.id] });
    },
    onError: (err: any) => {
      showToast(err?.message || 'Failed to revoke invitation', 'error');
    }
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Team Members & Roles"
        description="Manage organization access, assign permissions, and send invitations."
        actions={
          canManageMembers ? (
            <Button
              variant="accent"
              size="md"
              leftIcon={<UserPlus className="w-4 h-4" />}
              onClick={() => setIsInviteModalOpen(true)}
            >
              Invite Member
            </Button>
          ) : undefined
        }
      />

      {/* Active Members Table */}
      <div className="rounded-lg border border-slate-200 bg-white shadow-2xs overflow-hidden">
        <div className="p-4 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-[#142B4A]" />
            <h3 className="text-sm font-semibold text-slate-900">Active Members</h3>
          </div>
          <span className="text-xs text-slate-500">{members.length} members</span>
        </div>

        {isLoadingMembers ? (
          <div className="p-6">
            <TableSkeleton rows={3} cols={5} />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-slate-50/70 border-b border-slate-200 text-slate-600 font-semibold">
                  <th className="py-3 px-4">User</th>
                  <th className="py-3 px-4">Role</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Joined Date</th>
                  {canManageMembers && <th className="py-3 px-4 text-right">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {members.map((member: OrganizationMember) => (
                  <tr key={member.id} className="hover:bg-slate-50/60 transition-colors">
                    <td className="py-3 px-4">
                      <div className="font-medium text-slate-900">{member.email}</div>
                      <div className="text-[10px] text-slate-400 font-mono">ID: {member.userId.substring(0, 8)}...</div>
                    </td>
                    <td className="py-3 px-4">
                      {isOwner && member.role !== 'OWNER' ? (
                        <select
                          className="text-xs rounded border border-slate-300 py-1 px-2 bg-white text-slate-800"
                          value={member.role}
                          onChange={(e) =>
                            updateRoleMutation.mutate({
                              userId: member.userId,
                              newRole: e.target.value as OrganizationRole
                            })
                          }
                          disabled={updateRoleMutation.isPending}
                        >
                          <option value="ADMIN">ADMIN</option>
                          <option value="MEMBER">MEMBER</option>
                          <option value="VIEWER">VIEWER</option>
                        </select>
                      ) : (
                        <span className="font-mono text-[11px] font-semibold bg-slate-100 text-slate-800 px-2 py-0.5 rounded">
                          {member.role}
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <Badge variant={member.status === 'ACTIVE' ? 'success' : 'neutral'} size="sm">
                        {member.status}
                      </Badge>
                    </td>
                    <td className="py-3 px-4 text-slate-500 font-mono">
                      {formatDate(member.joinedAt)}
                    </td>
                    {canManageMembers && (
                      <td className="py-3 px-4 text-right">
                        {member.role !== 'OWNER' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-red-600 hover:text-red-700 hover:bg-red-50"
                            onClick={() => removeMemberMutation.mutate(member.userId)}
                            disabled={removeMemberMutation.isPending}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pending Invitations Section */}
      {canManageMembers && (
        <div className="rounded-lg border border-slate-200 bg-white shadow-2xs overflow-hidden">
          <div className="p-4 border-b border-slate-100 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Mail className="w-4 h-4 text-[#0F8B72]" />
              <h3 className="text-sm font-semibold text-slate-900">Pending Invitations</h3>
            </div>
            <span className="text-xs text-slate-500">{invitations.length} pending</span>
          </div>

          {isLoadingInvites ? (
            <div className="p-4">
              <TableSkeleton rows={2} cols={4} />
            </div>
          ) : invitations.length === 0 ? (
            <div className="p-6 text-center text-xs text-slate-400">
              No pending invitations for this organization.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-50/70 border-b border-slate-200 text-slate-600 font-semibold">
                    <th className="py-3 px-4">Invited Email</th>
                    <th className="py-3 px-4">Target Role</th>
                    <th className="py-3 px-4">Expires</th>
                    <th className="py-3 px-4 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {invitations.map((inv) => (
                    <tr key={inv.id} className="hover:bg-slate-50/60 transition-colors">
                      <td className="py-3 px-4 font-medium text-slate-900">{inv.email}</td>
                      <td className="py-3 px-4">
                        <span className="font-mono text-[11px] bg-slate-100 text-slate-700 px-2 py-0.5 rounded">
                          {inv.role}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-slate-500 font-mono">
                        {formatDate(inv.expiresAt)}
                      </td>
                      <td className="py-3 px-4 text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-red-600 border-red-200 hover:bg-red-50"
                          onClick={() => revokeInviteMutation.mutate(inv.id)}
                          disabled={revokeInviteMutation.isPending}
                        >
                          Revoke
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Invite Modal */}
      {activeOrg && (
        <InviteMemberModal
          isOpen={isInviteModalOpen}
          onClose={() => setIsInviteModalOpen(false)}
          organizationId={activeOrg.id}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ['org-invitations', activeOrg.id] });
          }}
        />
      )}
    </div>
  );
};
