import React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  FileSpreadsheet,
  ArrowLeft,
  RefreshCw,
  Receipt,
  Layers
} from 'lucide-react';
import { useCurrentOrg } from '../../context/OrgContext';
import { importsApi } from '../../api/imports.api';
import { PageHeader } from '../../components/layout/PageHeader';
import { Button } from '../../components/ui/Button';
import { StatusBadge } from '../../components/finance/StatusBadge';
import { ProcessingTimeline } from '../../components/finance/ProcessingTimeline';
import { TaxBreakdown } from '../../components/finance/TaxBreakdown';
import { Skeleton } from '../../components/ui/Skeleton';
import { Alert } from '../../components/ui/Alert';
import { formatDateTime } from '../../utils/dates';

export const ImportDetailsPage: React.FC = () => {
  const { batchId } = useParams<{ batchId: string }>();
  const { activeOrg } = useCurrentOrg();
  const navigate = useNavigate();

  // Load batch details
  const {
    data: batch,
    isLoading: isLoadingBatch,
    error: batchError,
    refetch: refetchBatch
  } = useQuery({
    queryKey: ['import-batch', activeOrg?.id, batchId],
    queryFn: () => (activeOrg && batchId ? importsApi.getBatch(activeOrg.id, batchId) : null),
    enabled: !!activeOrg?.id && !!batchId
  });

  // Load status with polling if actively in progress
  const isActivelyProcessing =
    batch?.status === 'QUEUED' ||
    batch?.status === 'PROCESSING' ||
    batch?.status === 'STAGING' ||
    batch?.status === 'UPLOAD_RECEIVED';

  const { data: statusData, refetch: refetchStatus } = useQuery({
    queryKey: ['import-status', activeOrg?.id, batchId],
    queryFn: () => (activeOrg && batchId ? importsApi.getStatus(activeOrg.id, batchId) : null),
    enabled: !!activeOrg?.id && !!batchId,
    refetchInterval: isActivelyProcessing ? 2000 : false
  });

  // Load summary if completed
  const { data: summary } = useQuery({
    queryKey: ['import-summary', activeOrg?.id, batchId],
    queryFn: () => (activeOrg && batchId ? importsApi.getSummary(activeOrg.id, batchId) : null),
    enabled: !!activeOrg?.id && !!batchId && batch?.status === 'COMPLETED'
  });

  const handleRefresh = () => {
    refetchBatch();
    refetchStatus();
  };

  if (isLoadingBatch) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (batchError || !batch) {
    return (
      <div className="space-y-6">
        <PageHeader title="Import Batch Not Found" />
        <Alert type="error">
          The requested import batch could not be found or you do not have permission to inspect it.
        </Alert>
        <Button variant="outline" onClick={() => navigate('/imports')}>
          Return to import history
        </Button>
      </div>
    );
  }

  const file = batch.files?.[0];
  const progressPct = statusData?.job?.progressPercentage || (batch.status === 'COMPLETED' ? 100 : 0);
  const currentCheckpoint = statusData?.job?.checkpoint || 'STAGE_VERIFICATION';

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          leftIcon={<ArrowLeft className="w-4 h-4" />}
          onClick={() => navigate('/imports')}
        >
          Back to imports
        </Button>
      </div>

      <PageHeader
        title={`Batch ${batch.batchNumber}`}
        description={`Imported on ${formatDateTime(batch.createdAt)} via ${batch.sourcePlatform} MTR adapter.`}
        badge={<StatusBadge status={batch.status} />}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              leftIcon={<RefreshCw className={`w-3.5 h-3.5 ${isActivelyProcessing ? 'animate-spin' : ''}`} />}
              onClick={handleRefresh}
            >
              Refresh status
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => navigate('/reconciliation')}
            >
              View in reconciliation
            </Button>
          </div>
        }
      />

      {/* Processing Pipeline Lifecycle Stepper */}
      <ProcessingTimeline
        status={batch.status}
        progressPercentage={progressPct}
        checkpoint={currentCheckpoint}
        errorMessage={statusData?.job?.errorMessage}
      />

      {/* Source File & Execution Configuration Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* File Metadata */}
        <div className="p-4 rounded-lg border border-slate-200 bg-white shadow-2xs">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-900 mb-3 pb-2 border-b border-slate-100">
            <FileSpreadsheet className="w-4 h-4 text-[#0F8B72]" />
            <span>Source File Metadata</span>
          </div>

          <div className="space-y-2 text-xs">
            <div className="flex justify-between py-1 border-b border-slate-50">
              <span className="text-slate-500">File Name</span>
              <span className="font-mono text-slate-800">{file?.fileName || 'amazon_mtr.csv'}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-50">
              <span className="text-slate-500">File Size</span>
              <span className="font-mono text-slate-800">
                {file?.fileSizeBytes
                  ? `${(Number(file.fileSizeBytes) / (1024 * 1024)).toFixed(2)} MB`
                  : '—'}
              </span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-50">
              <span className="text-slate-500">SHA-256 Digest</span>
              <span className="font-mono text-slate-600 truncate max-w-[200px]" title={file?.fileHash}>
                {file?.fileHash ? `${file.fileHash.substring(0, 16)}...` : '—'}
              </span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-slate-500">Execution Mode</span>
              <span className="font-mono text-slate-800">{batch.executionMode}</span>
            </div>
          </div>
        </div>

        {/* Engine & Statutory Environment */}
        <div className="p-4 rounded-lg border border-slate-200 bg-white shadow-2xs">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-900 mb-3 pb-2 border-b border-slate-100">
            <Layers className="w-4 h-4 text-[#142B4A]" />
            <span>Deterministic Engine Execution</span>
          </div>

          <div className="space-y-2 text-xs">
            <div className="flex justify-between py-1 border-b border-slate-50">
              <span className="text-slate-500">Engine Version</span>
              <span className="font-mono text-slate-800">{batch.engineVersion || '0.1.0'}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-50">
              <span className="text-slate-500">Statutory Rules Version</span>
              <span className="font-mono text-slate-800">{batch.rulesVersion || '2024.1'}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-50">
              <span className="text-slate-500">Total Records Staged</span>
              <span className="font-mono font-medium text-slate-900">
                {batch.totalRecordsProcessed.toLocaleString('en-IN')}
              </span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-slate-500">Finished Timestamp</span>
              <span className="font-mono text-slate-600">
                {formatDateTime(batch.completedAt)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Financial & Reconciliation Breakdown (when completed) */}
      {summary && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Receipt className="w-4 h-4 text-[#0F8B72]" />
            <h3 className="text-sm font-bold text-[#142B4A]">Statutory Reconciliation Summary</h3>
          </div>

          {/* Tax Breakdown */}
          <TaxBreakdown
            taxableValue={summary.invoices.totalTaxableAmount}
            cgst={summary.invoices.totalCgstAmount}
            sgst={summary.invoices.totalSgstAmount}
            igst={summary.invoices.totalIgstAmount}
          />

          {/* Detailed Transaction Outcome KPIs */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="p-4 rounded-lg border border-slate-200 bg-white">
              <div className="text-xs font-semibold text-slate-700 mb-2">Invoice Supplies</div>
              <div className="space-y-1.5 text-xs">
                <div className="flex justify-between">
                  <span className="text-slate-500">B2B Invoices:</span>
                  <span className="font-mono font-medium text-slate-900">{summary.invoices.b2b}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">B2C Invoices:</span>
                  <span className="font-mono font-medium text-slate-900">{summary.invoices.b2c}</span>
                </div>
              </div>
            </div>

            <div className="p-4 rounded-lg border border-slate-200 bg-white">
              <div className="text-xs font-semibold text-slate-700 mb-2">Credit Notes (Reversals)</div>
              <div className="space-y-1.5 text-xs">
                <div className="flex justify-between">
                  <span className="text-slate-500">Fully Reconciled:</span>
                  <span className="font-mono text-emerald-700 font-semibold">
                    {summary.creditNotes.reconciledFull}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Partial Matches:</span>
                  <span className="font-mono text-amber-700">
                    {summary.creditNotes.reconciledPartial}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Unreconciled / Orphan:</span>
                  <span className="font-mono text-purple-700">
                    {summary.creditNotes.unreconciled}
                  </span>
                </div>
              </div>
            </div>

            <div className="p-4 rounded-lg border border-slate-200 bg-white">
              <div className="text-xs font-semibold text-slate-700 mb-2">Stock & Distinct Persons</div>
              <div className="space-y-1.5 text-xs">
                <div className="flex justify-between">
                  <span className="text-slate-500">Stock Transfers:</span>
                  <span className="font-mono font-medium text-slate-900">
                    {summary.stockTransfers.count}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Distinct Persons:</span>
                  <span className="font-mono font-medium text-slate-900">
                    {summary.stockTransfers.distinctPersonCount}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
