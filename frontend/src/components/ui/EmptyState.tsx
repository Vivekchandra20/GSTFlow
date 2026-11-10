import React from 'react';
import { Button } from './Button';

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon,
  title,
  description,
  actionLabel,
  onAction,
  className = ''
}) => {
  return (
    <div
      className={`flex flex-col items-center justify-center text-center p-8 border border-dashed border-slate-200 rounded-lg bg-slate-50/50 ${className}`}
    >
      {icon && (
        <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center text-slate-500 mb-3">
          {icon}
        </div>
      )}
      <h4 className="text-sm font-semibold text-slate-900 mb-1">{title}</h4>
      <p className="text-xs text-slate-500 max-w-sm mb-4 leading-relaxed">{description}</p>
      {actionLabel && onAction && (
        <Button size="sm" variant="primary" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
};
