import React from 'react';
import { formatInr } from '../../utils/currency';

export interface CurrencyDisplayProps {
  amount: number | string | null | undefined;
  showSymbol?: boolean;
  showDecimals?: boolean;
  compact?: boolean;
  className?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  trend?: 'positive' | 'negative' | 'neutral';
}

export const CurrencyDisplay: React.FC<CurrencyDisplayProps> = ({
  amount,
  showSymbol = true,
  showDecimals = true,
  compact = false,
  className = '',
  size = 'md',
  trend = 'neutral'
}) => {
  const formatted = formatInr(amount, { showSymbol, showDecimals, compact });

  const sizeClasses = {
    sm: 'text-xs',
    md: 'text-sm font-medium',
    lg: 'text-lg font-semibold',
    xl: 'text-2xl font-bold'
  }[size];

  const trendClasses = {
    positive: 'text-emerald-700',
    negative: 'text-red-700',
    neutral: 'text-slate-900'
  }[trend];

  return (
    <span className={`font-mono tracking-tight ${sizeClasses} ${trendClasses} ${className}`}>
      {formatted}
    </span>
  );
};
