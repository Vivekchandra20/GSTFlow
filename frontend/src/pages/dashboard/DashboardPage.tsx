import React from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  UploadCloud,
  FileSpreadsheet,
  Scale,
  Building2,
  ArrowRight,
  TrendingUp,
  Receipt
} from 'lucide-react';
import { useCurrentOrg } from '../../context/OrgContext';
import { importsApi } from '../../api/imports.api';
import { gstRegistrationsApi } from '../../api/gst-registrations.api';
import { PageHeader } from '../../components/layout/PageHeader';
import { Button } from '../../components/ui/Button';
import { FinancialKpi } from '../../components/finance/FinancialKpi';
import { StatusBadge } from '../../components/finance/StatusBadge';
import { CurrencyDisplay } from '../../components/finance/CurrencyDisplay';
import { EmptyState } from '../../components/ui/EmptyState';
import { Skeleton, TableSkeleton } from '../../components/ui/Skeleton';
import { formatDate } from '../../utils/dates';
import { PendingInvitationsList } from '../../components/invitations/PendingInvitationsList';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Cell
} from 'recharts';

export const DashboardPage: React.FC = () => {
  const { activeOrg, canUpload } = useCurrentOrg();
  const navigate = useNavigate();

  // Load recent imports
  const { data: importsData, isLoading: isLoadingImports } = useQuery({
    queryKey: ['dashboard-imports', activeOrg?.id],
    queryFn: () => (activeOrg ? importsApi.list(activeOrg.id, { limit: 5 }) : null),
    enabled: !!activeOrg?.id
  });

  // Load registered GSTINs
  const { data: gstinData } = useQuery({
    queryKey: ['dashboard-gstins', activeOrg?.id],
    queryFn: () => (activeOrg ? gstRegistrationsApi.list(activeOrg.id) : null),
    enabled: !!activeOrg?.id
  });

  // Load financial summary of the latest completed batch if available
  const latestCompletedBatch = importsData?.items.find((item) => item.status === 'COMPLETED');
  const { data: latestSummary } = useQuery({
    queryKey: ['dashboard-summary', activeOrg?.id, latestCompletedBatch?.id],
    queryFn: () =>
      activeOrg && latestCompletedBatch
        ? importsApi.getSummary(activeOrg.id, latestCompletedBatch.id)
        : null,
    enabled: !!activeOrg?.id && !!latestCompletedBatch?.id
  });

  const importsList = importsData?.items || [];
  const gstinCount = gstinData?.registrations.length || 0;
  const totalImports = importsData?.pagination.total || 0;

  // Chart data based on actual summary numbers
  const chartData = latestSummary
    ? [
        { name: 'B2B Invoices', count: latestSummary.invoices.b2b, color: '#142B4A' },
        { name: 'B2C Invoices', count: latestSummary.invoices.b2c, color: '#1C3B61' },
        { name: 'Reconciled CNs', count: latestSummary.creditNotes.reconciledFull, color: '#0F8B72' },
        { name: 'Stock Transfers', count: latestSummary.stockTransfers.count, color: '#2563EB' }
      ]
    : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reconciliation Dashboard"
        description={`Overview of statutory GST filings, MTR processing batches, and tax liabilities for ${
          activeOrg?.name || 'your entity'
        }.`}
        actions={
          canUpload ? (
            <Button
              variant="accent"
              size="md"
              leftIcon={<UploadCloud className="w-4 h-4" />}
              onClick={() => navigate('/imports/new')}
            >
              Upload MTR Report
            </Button>
          ) : undefined
        }
      />

      {/* Discovered pending invitations */}
      <PendingInvitationsList />

      {/* Financial Overview KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {isLoadingImports ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="p-4 rounded-lg border border-slate-200 bg-white">
              <Skeleton className="h-4 w-24 mb-3" />
              <Skeleton className="h-8 w-32" />
            </div>
          ))
        ) : (
          <>
            <FinancialKpi
              label="Total Batches Processed"
              value={totalImports}
              icon={<FileSpreadsheet className="w-4 h-4" />}
              subtext="Historical MTR imports across all GSTINs"
            />

            <FinancialKpi
              label="Taxable Supply Value"
              value={latestSummary?.invoices.totalTaxableAmount || '0.00'}
              isCurrency
              icon={<TrendingUp className="w-4 h-4 text-[#0F8B72]" />}
              subtext={latestCompletedBatch ? `Latest batch (${latestCompletedBatch.batchNumber})` : 'Awaiting completed batch'}
            />

            <FinancialKpi
              label="Total Reconciled Tax"
              value={
                latestSummary
                  ? (
                      parseFloat(latestSummary.invoices.totalCgstAmount) +
                      parseFloat(latestSummary.invoices.totalSgstAmount) +
                      parseFloat(latestSummary.invoices.totalIgstAmount)
                    ).toFixed(2)
                  : '0.00'
              }
              isCurrency
              icon={<Scale className="w-4 h-4 text-[#142B4A]" />}
              subtext="CGST + SGST + IGST verified"
            />

            <FinancialKpi
              label="Active State GSTINs"
              value={gstinCount}
              icon={<Building2 className="w-4 h-4" />}
              subtext={
                gstinCount === 0 ? (
                  <Link to="/gst-registrations" className="text-[#0F8B72] hover:underline">
                    Add registration &rarr;
                  </Link>
                ) : (
                  'Configured distinct person entities'
                )
              }
            />
          </>
        )}
      </div>

      {/* Visual Chart & Summary Banner */}
      {latestSummary && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Chart */}
          <div className="lg:col-span-2 p-5 rounded-lg border border-slate-200 bg-white shadow-2xs">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  Transaction Composition
                </h3>
                <p className="text-xs text-slate-500">
                  Verified breakdown for batch {latestSummary.batchNumber}
                </p>
              </div>
              <span className="text-xs font-mono text-slate-500">
                {latestSummary.totalRecords.toLocaleString('en-IN')} total records
              </span>
            </div>

            <div className="h-60 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#64748B' }} />
                  <YAxis tick={{ fontSize: 11, fill: '#64748B' }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#FFFFFF',
                      borderRadius: '6px',
                      border: '1px solid #E2E8F0',
                      fontSize: '12px'
                    }}
                  />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                    {chartData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Quick Tax Summary Card */}
          <div className="p-5 rounded-lg border border-slate-200 bg-white shadow-2xs flex flex-col justify-between">
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Receipt className="w-4 h-4 text-[#0F8B72]" />
                <h3 className="text-sm font-semibold text-slate-900">Tax Liability Breakdown</h3>
              </div>
              <p className="text-xs text-slate-500 mb-4">
                Statutory tax breakdown calculated by GSTFlow deterministic engine.
              </p>

              <div className="space-y-2.5 text-xs">
                <div className="flex items-center justify-between pb-2 border-b border-slate-100">
                  <span className="text-slate-600">Central GST (CGST)</span>
                  <CurrencyDisplay amount={latestSummary.invoices.totalCgstAmount} size="sm" />
                </div>
                <div className="flex items-center justify-between pb-2 border-b border-slate-100">
                  <span className="text-slate-600">State GST (SGST)</span>
                  <CurrencyDisplay amount={latestSummary.invoices.totalSgstAmount} size="sm" />
                </div>
                <div className="flex items-center justify-between pb-2 border-b border-slate-100">
                  <span className="text-slate-600">Integrated GST (IGST)</span>
                  <CurrencyDisplay amount={latestSummary.invoices.totalIgstAmount} size="sm" />
                </div>
                <div className="flex items-center justify-between pt-1">
                  <span className="font-semibold text-slate-900">Credit Reversed</span>
                  <CurrencyDisplay
                    amount={latestSummary.creditNotes.totalReversedAmount}
                    size="sm"
                    className="text-[#0F8B72]"
                  />
                </div>
              </div>
            </div>

            <div className="pt-4 border-t border-slate-100 mt-4">
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => navigate(`/imports/${latestSummary.batchId}`)}
                rightIcon={<ArrowRight className="w-3.5 h-3.5" />}
              >
                Inspect batch details
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Recent Activity Section */}
      <div className="p-5 rounded-lg border border-slate-200 bg-white shadow-2xs">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Recent Import Batches</h3>
            <p className="text-xs text-slate-500">
              Latest marketplace CSV uploads and asynchronous reconciliation status
            </p>
          </div>
          {importsList.length > 0 && (
            <Link
              to="/imports"
              className="text-xs font-semibold text-[#0F8B72] hover:text-[#0B705D] flex items-center gap-1"
            >
              <span>View all imports</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          )}
        </div>

        {isLoadingImports ? (
          <TableSkeleton rows={4} cols={5} />
        ) : importsList.length === 0 ? (
          <EmptyState
            icon={<FileSpreadsheet className="w-6 h-6" />}
            title="No import batches found"
            description="Upload your first Amazon Seller Central MTR CSV report to trigger statutory reconciliation and generate tax reports."
            actionLabel="Upload MTR Report"
            onAction={() => navigate('/imports/new')}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500 font-medium">
                  <th className="py-2.5 px-3">Batch Number</th>
                  <th className="py-2.5 px-3">Platform</th>
                  <th className="py-2.5 px-3">Status</th>
                  <th className="py-2.5 px-3 text-right">Records</th>
                  <th className="py-2.5 px-3">Uploaded</th>
                  <th className="py-2.5 px-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {importsList.map((batch) => (
                  <tr key={batch.id} className="hover:bg-slate-50/70 transition-colors">
                    <td className="py-3 px-3 font-mono font-medium text-slate-900">
                      <Link
                        to={`/imports/${batch.id}`}
                        className="hover:text-[#0F8B72] hover:underline"
                      >
                        {batch.batchNumber}
                      </Link>
                    </td>
                    <td className="py-3 px-3">
                      <span className="font-semibold text-slate-700">{batch.sourcePlatform}</span>
                    </td>
                    <td className="py-3 px-3">
                      <StatusBadge status={batch.status} size="sm" />
                    </td>
                    <td className="py-3 px-3 font-mono text-right text-slate-800">
                      {batch.totalRecordsProcessed > 0
                        ? batch.totalRecordsProcessed.toLocaleString('en-IN')
                        : '—'}
                    </td>
                    <td className="py-3 px-3 text-slate-500">{formatDate(batch.createdAt)}</td>
                    <td className="py-3 px-3 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => navigate(`/imports/${batch.id}`)}
                      >
                        Details
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
