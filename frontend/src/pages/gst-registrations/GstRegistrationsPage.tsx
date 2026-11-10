import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Building2,
  Plus,
  Search,
  Filter
} from 'lucide-react';
import { useCurrentOrg } from '../../context/OrgContext';
import { gstRegistrationsApi } from '../../api/gst-registrations.api';
import { PageHeader } from '../../components/layout/PageHeader';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { GstinDisplay } from '../../components/finance/GstinDisplay';
import { StatusBadge } from '../../components/finance/StatusBadge';
import { EmptyState } from '../../components/ui/EmptyState';
import { TableSkeleton } from '../../components/ui/Skeleton';
import { AddGstRegistrationModal } from './AddGstRegistrationModal';
import { formatDate } from '../../utils/dates';
import { GstRegistration, GstRegistrationStatus } from '../../api/types';
import { useToast } from '../../context/ToastContext';

export const GstRegistrationsPage: React.FC = () => {
  const { activeOrg, canManageGstin } = useCurrentOrg();
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['gst-registrations', activeOrg?.id, searchTerm, statusFilter],
    queryFn: () =>
      activeOrg
        ? gstRegistrationsApi.list(activeOrg.id, {
            search: searchTerm || undefined,
            status: (statusFilter as GstRegistrationStatus) || undefined
          })
        : null,
    enabled: !!activeOrg?.id
  });

  const registrations = data?.registrations || [];

  // Status transition mutation
  const statusMutation = useMutation({
    mutationFn: async ({
      id,
      newStatus
    }: {
      id: string;
      newStatus: GstRegistrationStatus;
    }) => {
      if (!activeOrg) throw new Error('No active organization');
      return gstRegistrationsApi.updateStatus(activeOrg.id, id, {
        status: newStatus,
        reason: `Status changed to ${newStatus} via web dashboard`
      });
    },
    onSuccess: (_, variables) => {
      showToast(`GSTIN registration status updated to ${variables.newStatus}`, 'success');
      queryClient.invalidateQueries({ queryKey: ['gst-registrations', activeOrg?.id] });
    },
    onError: (err: any) => {
      showToast(err?.message || 'Failed to update registration status', 'error');
    }
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="GST Registrations"
        description="Manage statutory GSTIN registrations, state jurisdictions, and distinct person configurations."
        actions={
          canManageGstin ? (
            <Button
              variant="accent"
              size="md"
              leftIcon={<Plus className="w-4 h-4" />}
              onClick={() => setIsAddModalOpen(true)}
            >
              Add GSTIN
            </Button>
          ) : undefined
        }
      />

      {/* Filter and Search Bar */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-4 rounded-lg border border-slate-200 bg-white shadow-2xs">
        <div className="w-full sm:max-w-xs">
          <Input
            placeholder="Search by GSTIN or business name..."
            leftIcon={<Search className="w-4 h-4 text-slate-400" />}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <Filter className="w-4 h-4 text-slate-400 shrink-0" />
          <select
            className="text-xs rounded-md border border-slate-300 py-1.5 px-2.5 bg-white text-slate-800 focus:outline-none focus:ring-1 focus:ring-[#142B4A]"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">All Statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="CANCELLED">Cancelled</option>
            <option value="SUSPENDED">Suspended</option>
            <option value="INACTIVE">Inactive</option>
          </select>
        </div>
      </div>

      {/* Registrations Data Table */}
      <div className="rounded-lg border border-slate-200 bg-white shadow-2xs overflow-hidden">
        {isLoading ? (
          <div className="p-6">
            <TableSkeleton rows={4} cols={6} />
          </div>
        ) : registrations.length === 0 ? (
          <div className="p-8">
            <EmptyState
              icon={<Building2 className="w-6 h-6" />}
              title="No GSTIN registrations found"
              description="Register your state GSTIN numbers to link marketplace sales reports and enable credit note reconciliation."
              actionLabel={canManageGstin ? 'Add first GSTIN' : undefined}
              onAction={canManageGstin ? () => setIsAddModalOpen(true) : undefined}
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-slate-50/70 border-b border-slate-200 text-slate-600 font-semibold">
                  <th className="py-3 px-4">GSTIN</th>
                  <th className="py-3 px-4">Legal Business Name</th>
                  <th className="py-3 px-4">Trade Name</th>
                  <th className="py-3 px-4">Type</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Effective From</th>
                  {canManageGstin && <th className="py-3 px-4 text-right">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {registrations.map((reg: GstRegistration) => (
                  <tr key={reg.id} className="hover:bg-slate-50/60 transition-colors">
                    <td className="py-3 px-4">
                      <GstinDisplay gstin={reg.gstin} />
                    </td>
                    <td className="py-3 px-4 font-medium text-slate-900 max-w-xs truncate">
                      {reg.legalName}
                    </td>
                    <td className="py-3 px-4 text-slate-600 max-w-xs truncate">
                      {reg.tradeName || '—'}
                    </td>
                    <td className="py-3 px-4">
                      <span className="font-mono text-[11px] bg-slate-100 text-slate-700 px-2 py-0.5 rounded">
                        {reg.registrationType}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <StatusBadge status={reg.status} size="sm" />
                    </td>
                    <td className="py-3 px-4 text-slate-500 font-mono">
                      {formatDate(reg.effectiveDate)}
                    </td>
                    {canManageGstin && (
                      <td className="py-3 px-4 text-right">
                        {reg.status === 'ACTIVE' ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              statusMutation.mutate({ id: reg.id, newStatus: 'CANCELLED' })
                            }
                            disabled={statusMutation.isPending}
                          >
                            Deactivate
                          </Button>
                        ) : reg.status === 'INACTIVE' || reg.status === 'SUSPENDED' ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() =>
                              statusMutation.mutate({ id: reg.id, newStatus: 'ACTIVE' })
                            }
                            disabled={statusMutation.isPending}
                          >
                            Reactivate
                          </Button>
                        ) : (
                          <span className="text-slate-400 font-mono text-[11px]">Finalized</span>
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

      {/* Add Modal */}
      {activeOrg && (
        <AddGstRegistrationModal
          isOpen={isAddModalOpen}
          onClose={() => setIsAddModalOpen(false)}
          organizationId={activeOrg.id}
          organizationPan={activeOrg.name}
          onSuccess={() => refetch()}
        />
      )}
    </div>
  );
};
