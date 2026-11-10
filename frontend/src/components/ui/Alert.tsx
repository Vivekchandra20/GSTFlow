import React from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from 'lucide-react';

export type AlertType = 'info' | 'success' | 'warning' | 'error';

export interface AlertProps {
  type?: AlertType;
  title?: string;
  children: React.ReactNode;
  className?: string;
}

export const Alert: React.FC<AlertProps> = ({
  type = 'info',
  title,
  children,
  className = ''
}) => {
  const config = {
    info: {
      container: 'bg-blue-50/70 border-blue-200 text-blue-900',
      icon: <Info className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
    },
    success: {
      container: 'bg-emerald-50/70 border-emerald-200 text-emerald-900',
      icon: <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
    },
    warning: {
      container: 'bg-amber-50/70 border-amber-200 text-amber-900',
      icon: <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
    },
    error: {
      container: 'bg-red-50/70 border-red-200 text-red-900',
      icon: <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
    }
  }[type];

  return (
    <div
      role="alert"
      className={`flex items-start gap-3 p-3.5 rounded-lg border text-xs leading-relaxed ${config.container} ${className}`}
    >
      {config.icon}
      <div className="flex-1">
        {title && <div className="font-semibold mb-0.5">{title}</div>}
        <div>{children}</div>
      </div>
    </div>
  );
};
