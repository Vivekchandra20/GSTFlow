import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronRight, Home } from 'lucide-react';

const ROUTE_LABELS: Record<string, string> = {
  dashboard: 'Dashboard',
  imports: 'Imports',
  new: 'New Import',
  reconciliation: 'Reconciliation',
  discrepancies: 'Discrepancies',
  'gst-registrations': 'GST Registrations',
  settings: 'Settings',
  members: 'Team Members'
};

export const Breadcrumb: React.FC = () => {
  const location = useLocation();
  const pathnames = location.pathname.split('/').filter((x) => x);

  if (pathnames.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-xs text-slate-500">
      <Link
        to="/dashboard"
        className="flex items-center text-slate-400 hover:text-slate-600 transition-colors"
        aria-label="Home"
      >
        <Home className="w-3.5 h-3.5" />
      </Link>

      {pathnames.map((segment, index) => {
        const routeTo = `/${pathnames.slice(0, index + 1).join('/')}`;
        const isLast = index === pathnames.length - 1;
        const label = ROUTE_LABELS[segment] || (segment.length > 20 ? `${segment.slice(0, 8)}...` : segment);

        return (
          <React.Fragment key={routeTo}>
            <ChevronRight className="w-3 h-3 text-slate-300 shrink-0" />
            {isLast ? (
              <span className="font-medium text-slate-800" aria-current="page">
                {label}
              </span>
            ) : (
              <Link to={routeTo} className="hover:text-slate-700 transition-colors">
                {label}
              </Link>
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
};
