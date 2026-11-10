import React from 'react';
import { CurrencyDisplay } from './CurrencyDisplay';

export interface TaxBreakdownProps {
  taxableValue: string | number;
  cgst: string | number;
  sgst: string | number;
  igst: string | number;
  className?: string;
}

export const TaxBreakdown: React.FC<TaxBreakdownProps> = ({
  taxableValue,
  cgst,
  sgst,
  igst,
  className = ''
}) => {
  const numCgst = typeof cgst === 'string' ? parseFloat(cgst) || 0 : cgst || 0;
  const numSgst = typeof sgst === 'string' ? parseFloat(sgst) || 0 : sgst || 0;
  const numIgst = typeof igst === 'string' ? parseFloat(igst) || 0 : igst || 0;
  const totalTax = numCgst + numSgst + numIgst;

  return (
    <div className={`grid grid-cols-2 sm:grid-cols-5 gap-3 p-3.5 rounded-lg border border-slate-200 bg-white ${className}`}>
      <div className="flex flex-col">
        <span className="text-[11px] text-slate-500 font-medium">Taxable Value</span>
        <CurrencyDisplay amount={taxableValue} size="md" className="text-slate-900 mt-0.5" />
      </div>
      <div className="flex flex-col">
        <span className="text-[11px] text-slate-500 font-medium">CGST</span>
        <CurrencyDisplay amount={cgst} size="md" className="text-slate-700 mt-0.5" />
      </div>
      <div className="flex flex-col">
        <span className="text-[11px] text-slate-500 font-medium">SGST</span>
        <CurrencyDisplay amount={sgst} size="md" className="text-slate-700 mt-0.5" />
      </div>
      <div className="flex flex-col">
        <span className="text-[11px] text-slate-500 font-medium">IGST</span>
        <CurrencyDisplay amount={igst} size="md" className="text-slate-700 mt-0.5" />
      </div>
      <div className="flex flex-col border-t sm:border-t-0 sm:border-l border-slate-200 pt-2 sm:pt-0 sm:pl-3 col-span-2 sm:col-span-1">
        <span className="text-[11px] text-[#0F8B72] font-semibold">Total GST</span>
        <CurrencyDisplay amount={totalTax} size="md" className="text-[#0F8B72] font-bold mt-0.5" />
      </div>
    </div>
  );
};
