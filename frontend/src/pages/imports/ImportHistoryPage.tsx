import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  FileSpreadsheet,
  UploadCloud,
  Filter,
  ChevronLeft,
  ChevronRight,
  Eye,
  RefreshCw
} from 'lucide-react';
import { useCurrentOrg } from '../../context/OrgContext';
import { importsApi } from '../../api/imports.api';
import { PageHeader } from '../../components/layout/PageHeader';
import { Button } from '../../components/ui/Button';
import { StatusBadge } from '../../components/finance/StatusBadge';
import { EmptyState } from '../../components/ui/EmptyState';
import { TableSkeleton } from '../../components/ui/Skeleton';
import { formatDate } from '../../utils/dates';
import { ImportBatchStatus } from '../../api/types';

export const ImportHistoryPage: React.FC = () => {
  const { activeOrg, canUpload } = useCurrentOrg();
  const navigate = useNavigate();

  const [page, setPage] = useState(1);
  const [limit] = useState(15);
  const [statusFilter, setStatusFilter] = useState<string>('');

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['import-history', activeOrg?.id, page, limit, statusFilter],
    queryFn: () =>
      activeOrg
        ? importsApi.list(activeOrg.id, {
            page,
            limit,
            status: (statusFilter as ImportBatchStatus) || undefined
          })
        : null,
    enabled: !!activeOrg?.id
  });

  const items = data?.items || [];
  const pagination = data?.pagination || { page: 1, limit: 15, total: 0, totalPages: 1 };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Import History"
        description="Audit log of all uploaded marketplace source reports, background reconciliation jobs, and batch records."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="md"
              leftIcon={<RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />}
              onClick={() => refetch()}
              disabled={isFetching}
            >
              Refresh
            </Button>
            {canUpload && (
              <Button
                variant="accent"
                size="md"
                leftIcon={<UploadCloud className="w-4 h-4" />}
                onClick={() => navigate('/imports/new')}
              >
                Upload MTR
              </Button>
            )}
          </div>
        }
      />

      {/* Filter Bar */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-4 rounded-lg border border-slate-200 bg-white shadow-2xs">
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <Filter className="w-4 h-4 text-slate-400 shrink-0" />
          <span className="text-xs font-medium text-slate-600">Filter Status:</span>
          <select
            className="text-xs rounded-md border border-slate-300 py-1.5 px-2.5 bg-white text-slate-800 focus:outline-none focus:ring-1 focus:ring-[#142B4A]"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All Statuses</option>
            <option value="COMPLETED">Completed</option>
            <option value="PROCESSING">Processing</option>
            <option value="QUEUED">Queued</option>
            <option value="STAGING">Staging</option>
            <option value="FAILED">Failed</option>
          </select>
        </div>

        <div className="text-xs text-slate-500">
          Showing {items.length} of {pagination.total} batches
        </div>
      </div>

      {/* Imports Table */}
      <div className="rounded-lg border border-slate-200 bg-white shadow-2xs overflow-hidden">
        {isLoading ? (
          <div className="p-6">
            <TableSkeleton rows={5} cols={6} />
          </div>
        ) : items.length === 0 ? (
          <div className="p-8">
            <EmptyState
              icon={<FileSpreadsheet className="w-6 h-6" />}
              title="No import batches found"
              description={
                statusFilter
                  ? `No batches matching the filter "${statusFilter}".`
                  : 'Start by uploading your first Amazon Seller Central MTR report.'
              }
              actionLabel={canUpload ? 'Upload MTR Report' : undefined}
              onAction={canUpload ? () => navigate('/imports/new') : undefined}
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-slate-50/70 border-b border-slate-200 text-slate-600 font-semibold">
                  <th className="py-3 px-4">Batch Number</th>
                  <th className="py-3 px-4">Platform</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4 text-right">Records Processed</th>
                  <th className="py-3 px-4">Rules Version</th>
                  <th className="py-3 px-4">Uploaded</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((batch) => (
                  <tr key={batch.id} className="hover:bg-slate-50/60 transition-colors">
                    <td className="py-3 px-4 font-mono font-medium text-slate-900">
                      <Link
                        to={`/imports/${batch.id}`}
                        className="hover:text-[#0F8B72] hover:underline"
                      >
                        {batch.batchNumber}
                      </Link>
                    </td>
                    <td className="py-3 px-4">
                      <span className="font-semibold text-slate-800">{batch.sourcePlatform}</span>
                    </td>
                    <td className="py-3 px-4">
                      <StatusBadge status={batch.status} size="sm" />
                    </td>
                    <td className="py-3 px-4 font-mono text-right text-slate-900">
                      {batch.totalRecordsProcessed > 0
                        ? batch.totalRecordsProcessed.toLocaleString('en-IN')
                        : '—'}
                    </td>
                    <td className="py-3 px-4 font-mono text-slate-500">
                      {batch.rulesVersion || '2024.1'}
                    </td>
                    <td className="py-3 px-4 text-slate-500 font-mono">
                      {formatDate(batch.createdAt)}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        leftIcon={<Eye className="w-3.5 h-3.5" />}
                        onClick={() => navigate(`/imports/${batch.id}`)}
                      >
                        Inspect
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination controls */}
        {pagination.totalPages > 1 && (
          <div className="flex items-center justify-between p-4 border-t border-slate-100 text-xs">
            <span className="text-slate-500">
              Page {pagination.page} of {pagination.totalPages}
            </span>
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="outline"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={page >= pagination.totalPages}
                onClick={() => setPage((p) => Math.min(pagination.totalPages, p + 1))}
              >
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
