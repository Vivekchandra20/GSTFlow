import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { getStateNameByCode } from '../../utils/gstin';

export interface GstinDisplayProps {
  gstin: string;
  showStateLabel?: boolean;
  copyable?: boolean;
  className?: string;
}

export const GstinDisplay: React.FC<GstinDisplayProps> = ({
  gstin,
  showStateLabel = true,
  copyable = true,
  className = ''
}) => {
  const [copied, setCopied] = useState(false);

  if (!gstin) return <span className="text-slate-400 font-mono text-xs">—</span>;

  const stateCode = gstin.length >= 2 ? gstin.substring(0, 2) : '';
  const panPart = gstin.length >= 12 ? gstin.substring(2, 12) : '';
  const suffixPart = gstin.length > 12 ? gstin.substring(12) : '';

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(gstin);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={`inline-flex items-center gap-1.5 ${className}`}>
      <span className="font-mono text-xs tracking-wider bg-slate-100/90 text-slate-800 px-2 py-0.5 rounded border border-slate-200">
        <span className="text-[#0F8B72] font-semibold">{stateCode}</span>
        <span className="text-slate-900 font-medium">{panPart}</span>
        <span className="text-slate-600">{suffixPart}</span>
      </span>

      {showStateLabel && stateCode && (
        <span className="text-[11px] text-slate-500 hidden sm:inline" title={getStateNameByCode(stateCode)}>
          ({getStateNameByCode(stateCode)})
        </span>
      )}

      {copyable && (
        <button
          type="button"
          onClick={handleCopy}
          className="p-1 text-slate-400 hover:text-slate-600 rounded transition-colors"
          title="Copy GSTIN"
          aria-label="Copy GSTIN"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
      )}
    </div>
  );
};
