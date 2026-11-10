import React, { useState, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  UploadCloud,
  Building2,
  ArrowRight,
  Info,
  X,
  FileCheck
} from 'lucide-react';
import { useCurrentOrg } from '../../context/OrgContext';
import { importsApi } from '../../api/imports.api';
import { gstRegistrationsApi } from '../../api/gst-registrations.api';
import { PageHeader } from '../../components/layout/PageHeader';
import { Button } from '../../components/ui/Button';
import { Alert } from '../../components/ui/Alert';
import { extractErrorMessage } from '../../utils/errors';
import { useToast } from '../../context/ToastContext';

export const ImportCenterPage: React.FC = () => {
  const { activeOrg, canUpload } = useCurrentOrg();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [selectedGstinId, setSelectedGstinId] = useState<string>('');
  const [selectedPlatform, setSelectedPlatform] = useState<'AMAZON' | 'FLIPKART' | 'MEESHO' | 'CUSTOM'>('AMAZON');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Load active registrations
  const { data: gstinData, isLoading: isLoadingGstins } = useQuery({
    queryKey: ['import-gstins', activeOrg?.id],
    queryFn: () =>
      activeOrg ? gstRegistrationsApi.list(activeOrg.id, { status: 'ACTIVE' }) : null,
    enabled: !!activeOrg?.id
  });

  const activeRegistrations = gstinData?.registrations || [];

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const validateAndSetFile = (file: File) => {
    setUploadError(null);

    if (!file.name.toLowerCase().endsWith('.csv')) {
      setUploadError('Only CSV (.csv) files are supported for marketplace MTR reconciliation.');
      return;
    }

    // 50 MB limit
    const MAX_SIZE_BYTES = 50 * 1024 * 1024;
    if (file.size > MAX_SIZE_BYTES) {
      setUploadError(
        `File size (${(file.size / (1024 * 1024)).toFixed(1)} MB) exceeds the maximum allowed upload limit of 50 MB.`
      );
      return;
    }

    setSelectedFile(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      validateAndSetFile(e.dataTransfer.files[0]);
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      validateAndSetFile(e.target.files[0]);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeOrg) return;

    if (!selectedGstinId) {
      setUploadError('Please select an active GSTIN registration.');
      return;
    }

    if (!selectedFile) {
      setUploadError('Please select an Amazon MTR CSV report to upload.');
      return;
    }

    setUploadError(null);
    setIsUploading(true);

    try {
      const res = await importsApi.upload(activeOrg.id, {
        file: selectedFile,
        gstRegistrationId: selectedGstinId,
        sourcePlatform: selectedPlatform
      });

      showToast(`Batch ${res.batchNumber} created and queued for background reconciliation`, 'success');
      navigate(`/imports/${res.batchId}`);
    } catch (err: unknown) {
      setUploadError(extractErrorMessage(err, 'Failed to upload source report.'));
    } finally {
      setIsUploading(false);
    }
  };

  if (!canUpload) {
    return (
      <div className="space-y-6">
        <PageHeader title="Upload MTR Report" />
        <Alert type="warning">
          You do not have permission to upload source files in this organization. Contact your
          administrator.
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <PageHeader
        title="Import Center"
        description="Upload marketplace sales reports to trigger deterministic tax computation and credit note reconciliation."
      />

      {uploadError && (
        <Alert type="error" className="mb-4">
          {uploadError}
        </Alert>
      )}

      {activeRegistrations.length === 0 && !isLoadingGstins && (
        <Alert type="warning" title="No Active GSTIN Registrations">
          You must register at least one active state GSTIN before uploading marketplace reports.{' '}
          <Link to="/gst-registrations" className="font-semibold underline">
            Register a GSTIN now &rarr;
          </Link>
        </Alert>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Step 1: Destination GSTIN & Platform */}
        <div className="p-5 rounded-lg border border-slate-200 bg-white shadow-2xs space-y-4">
          <div className="flex items-center gap-2 pb-3 border-b border-slate-100">
            <Building2 className="w-4 h-4 text-[#142B4A]" />
            <h3 className="text-sm font-semibold text-slate-900">1. Select Filing Scope</h3>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-medium text-slate-700 block mb-1.5">
                Reporting GSTIN <span className="text-red-500">*</span>
              </label>
              <select
                className="w-full rounded-md border border-slate-300 py-2 px-3 text-xs bg-white text-slate-900 focus:outline-none focus:ring-1 focus:ring-[#142B4A]"
                value={selectedGstinId}
                onChange={(e) => setSelectedGstinId(e.target.value)}
                required
              >
                <option value="">— Select registered GSTIN —</option>
                {activeRegistrations.map((reg) => (
                  <option key={reg.id} value={reg.id}>
                    {reg.gstin} ({reg.stateCode} - {reg.legalName})
                  </option>
                ))}
              </select>
              <span className="text-[11px] text-slate-500 mt-1 block">
                The seller state registration against which taxes will be computed.
              </span>
            </div>

            <div>
              <label className="text-xs font-medium text-slate-700 block mb-1.5">
                Source Marketplace Platform <span className="text-red-500">*</span>
              </label>
              <select
                className="w-full rounded-md border border-slate-300 py-2 px-3 text-xs bg-white text-slate-900 focus:outline-none focus:ring-1 focus:ring-[#142B4A]"
                value={selectedPlatform}
                onChange={(e) => setSelectedPlatform(e.target.value as any)}
              >
                <option value="AMAZON">Amazon Seller Central (MTR Live Adapter)</option>
                <option value="FLIPKART" disabled>
                  Flipkart (Phase 5C — Pending)
                </option>
                <option value="MEESHO" disabled>
                  Meesho (Phase 5C — Pending)
                </option>
                <option value="CUSTOM" disabled>
                  Custom Format
                </option>
              </select>
              <span className="text-[11px] text-slate-500 mt-1 block">
                Official Merchant Tax Report (MTR) schema with Section 10(1)(ca) POS resolution.
              </span>
            </div>
          </div>
        </div>

        {/* Step 2: Drag & Drop File Zone */}
        <div className="p-5 rounded-lg border border-slate-200 bg-white shadow-2xs space-y-4">
          <div className="flex items-center gap-2 pb-3 border-b border-slate-100">
            <UploadCloud className="w-4 h-4 text-[#0F8B72]" />
            <h3 className="text-sm font-semibold text-slate-900">2. Upload Source CSV</h3>
          </div>

          {!selectedFile ? (
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`flex flex-col items-center justify-center p-8 border-2 border-dashed rounded-lg cursor-pointer transition-colors ${
                isDragging
                  ? 'border-[#0F8B72] bg-emerald-50/50'
                  : 'border-slate-300 hover:border-[#142B4A] bg-slate-50/50'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                className="hidden"
                onChange={handleFileInputChange}
              />
              <div className="w-12 h-12 rounded-full bg-[#EAF0F7] text-[#142B4A] flex items-center justify-center mb-3">
                <UploadCloud className="w-6 h-6" />
              </div>
              <p className="text-sm font-medium text-slate-800">
                Click to browse or drag & drop Amazon MTR CSV
              </p>
              <p className="text-xs text-slate-500 mt-1">
                CSV format only (Max 50 MB) • UTF-8 encoded
              </p>
            </div>
          ) : (
            <div className="p-4 rounded-lg border border-emerald-200 bg-emerald-50/40 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-emerald-100 text-emerald-800 flex items-center justify-center">
                  <FileCheck className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-xs font-semibold text-slate-900">{selectedFile.name}</div>
                  <div className="text-[11px] text-slate-500 font-mono mt-0.5">
                    {(selectedFile.size / (1024 * 1024)).toFixed(2)} MB • Ready for staging
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedFile(null)}
                className="p-1.5 text-slate-400 hover:text-slate-600 rounded transition-colors"
                aria-label="Remove selected file"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Guidelines Banner */}
          <div className="bg-slate-50 p-3.5 rounded-lg border border-slate-200 text-xs text-slate-600 space-y-1.5">
            <div className="font-semibold text-slate-800 flex items-center gap-1.5">
              <Info className="w-3.5 h-3.5 text-blue-600" />
              <span>Statutory Staging Guarantees</span>
            </div>
            <ul className="list-disc pl-5 space-y-1 text-[11px] text-slate-500">
              <li>Deterministic SHA-256 duplicate batch detection prevents duplicate filings.</li>
              <li>Row-Level Security (RLS) ensures source records are strictly tenant-isolated.</li>
              <li>Streaming architecture processes large files without out-of-memory crashes.</li>
            </ul>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 pt-2">
          <Button type="button" variant="outline" onClick={() => navigate('/imports')}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="accent"
            size="lg"
            isLoading={isUploading}
            disabled={!selectedFile || !selectedGstinId || isUploading}
            rightIcon={<ArrowRight className="w-4 h-4" />}
          >
            Start reconciliation batch
          </Button>
        </div>
      </form>
    </div>
  );
};
