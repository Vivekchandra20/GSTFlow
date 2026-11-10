import React from 'react';
import { Breadcrumb } from './Breadcrumb';

export interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  badge?: React.ReactNode;
}

export const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  description,
  actions,
  badge
}) => {
  return (
    <div className="mb-6 flex flex-col gap-3">
      <Breadcrumb />
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-bold tracking-tight text-[#142B4A]">{title}</h1>
            {badge && <div>{badge}</div>}
          </div>
          {description && <p className="text-xs text-slate-500 mt-1 max-w-2xl">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-2.5 shrink-0">{actions}</div>}
      </div>
    </div>
  );
};
