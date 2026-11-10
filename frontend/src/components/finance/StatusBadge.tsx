import React from 'react';
import { Badge, BadgeVariant } from '../ui/Badge';
import { CheckCircle2, AlertTriangle, AlertCircle, Clock, RefreshCw } from 'lucide-react';

export type FinancialStatus =
  | 'VALID'
  | 'WARNING'
  | 'REVIEW'
  | 'REVIEW_REQUIRED'
  | 'ERROR'
  | 'COMPLETED'
  | 'PROCESSING'
  | 'QUEUED'
  | 'STAGING'
  | 'FAILED'
  | 'ACTIVE'
  | 'CANCELLED'
  | 'SUSPENDED';

export interface StatusBadgeProps {
  status: FinancialStatus | string;
  className?: string;
  size?: 'sm' | 'md';
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status, className, size = 'md' }) => {
  const normalized = (status || '').toUpperCase();

  let variant: BadgeVariant = 'neutral';
  let label = status;
  let icon: React.ReactNode = null;

  switch (normalized) {
    case 'VALID':
    case 'COMPLETED':
    case 'ACTIVE':
      variant = 'success';
      label = normalized === 'VALID' ? 'Valid' : normalized === 'ACTIVE' ? 'Active' : 'Completed';
      icon = <CheckCircle2 className="w-3 h-3" />;
      break;

    case 'WARNING':
      variant = 'warning';
      label = 'Warning';
      icon = <AlertTriangle className="w-3 h-3" />;
      break;

    case 'REVIEW':
    case 'REVIEW_REQUIRED':
      variant = 'review';
      label = 'Review Required';
      icon = <AlertCircle className="w-3 h-3" />;
      break;

    case 'ERROR':
    case 'FAILED':
    case 'CANCELLED':
      variant = 'error';
      label = normalized === 'CANCELLED' ? 'Cancelled' : normalized === 'ERROR' ? 'Error' : 'Failed';
      icon = <AlertCircle className="w-3 h-3" />;
      break;

    case 'PROCESSING':
      variant = 'info';
      label = 'Processing';
      icon = <RefreshCw className="w-3 h-3 animate-spin" />;
      break;

    case 'QUEUED':
    case 'STAGING':
    case 'UPLOAD_RECEIVED':
      variant = 'neutral';
      label = normalized === 'QUEUED' ? 'Queued' : 'Staging';
      icon = <Clock className="w-3 h-3" />;
      break;

    case 'SUSPENDED':
      variant = 'warning';
      label = 'Suspended';
      icon = <AlertTriangle className="w-3 h-3" />;
      break;

    default:
      variant = 'neutral';
      label = status;
  }

  return (
    <Badge variant={variant} size={size} icon={icon} className={className}>
      {label}
    </Badge>
  );
};
