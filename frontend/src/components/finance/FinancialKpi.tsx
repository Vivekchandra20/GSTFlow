import React from 'react';
import { CurrencyDisplay } from './CurrencyDisplay';

export interface FinancialKpiProps {
  label: string;
  value: string | number;
  isCurrency?: boolean;
  subtext?: React.ReactNode;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
  className?: string;
}

export const FinancialKpi: React.FC<FinancialKpiProps> = ({
  label,
  value,
  isCurrency = false,
  subtext,
  icon,
  badge,
  className = ''
}) => {
  return (
    <div
      className={`p-4 rounded-lg border border-slate-200 bg-white shadow-2xs hover:border-slate-300 transition-colors ${className}`}
    >
      <div className="flex items-center justify-between text-xs text-slate-500 mb-2">
        <span className="font-medium tracking-normal text-slate-600">{label}</span>
        {icon && <span className="text-slate-400">{icon}</span>}
      </div>

      <div className="flex items-baseline justify-between gap-2">
        <div className="text-2xl font-bold text-slate-900 font-mono tracking-tight">
          {isCurrency ? (
            <CurrencyDisplay amount={value} size="xl" />
          ) : (
            typeof value === 'number' ? value.toLocaleString('en-IN') : value
          )}
        </div>
        {badge && <div className="shrink-0">{badge}</div>}
      </div>

      {subtext && <div className="text-xs text-slate-500 mt-1.5 leading-normal">{subtext}</div>}
    </div>
  );
};
