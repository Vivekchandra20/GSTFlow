import React from 'react';
import { Check, Clock, AlertCircle, RefreshCw } from 'lucide-react';
import { ImportBatchStatus } from '../../api/types';

export interface ProcessingTimelineProps {
  status: ImportBatchStatus;
  progressPercentage?: number;
  checkpoint?: string;
  errorMessage?: string | null;
  className?: string;
}

const STAGES = [
  { id: 'UPLOAD_RECEIVED', label: 'Upload Received' },
  { id: 'STAGING', label: 'Source Staged' },
  { id: 'PROCESSING', label: 'Domain Engine Processing' },
  { id: 'COMPLETED', label: 'Reconciliation Ready' }
];

export const ProcessingTimeline: React.FC<ProcessingTimelineProps> = ({
  status,
  progressPercentage = 0,
  checkpoint,
  errorMessage,
  className = ''
}) => {
  const isFailed = status === 'FAILED';
  const isCompleted = status === 'COMPLETED';

  const getStageStatus = (stageId: string, index: number) => {
    if (isFailed && stageId === 'PROCESSING') return 'failed';
    if (isCompleted) return 'completed';

    const stageMap: Record<string, number> = {
      UPLOAD_RECEIVED: 0,
      STAGING: 1,
      STAGING_COMPLETED: 1,
      QUEUED: 2,
      PROCESSING: 2,
      COMPLETED: 3
    };

    const currentLevel = stageMap[status] ?? 0;
    if (index < currentLevel) return 'completed';
    if (index === currentLevel) return 'active';
    return 'pending';
  };

  return (
    <div className={`p-4 rounded-lg border border-slate-200 bg-white ${className}`}>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h4 className="text-xs font-semibold text-slate-800">Processing Pipeline</h4>
          {checkpoint && (
            <p className="text-[11px] text-slate-500 font-mono mt-0.5">
              Checkpoint: {checkpoint}
            </p>
          )}
        </div>
        <div className="text-right">
          <span className="text-xs font-mono font-bold text-slate-900">
            {isCompleted ? '100%' : `${progressPercentage}%`}
          </span>
        </div>
      </div>

      {/* Progress bar */}
      <div className="w-full bg-slate-100 rounded-full h-1.5 mb-6 overflow-hidden">
        <div
          className={`h-1.5 transition-all duration-300 ${
            isFailed ? 'bg-red-500' : isCompleted ? 'bg-emerald-600' : 'bg-[#142B4A]'
          }`}
          style={{ width: `${isCompleted ? 100 : progressPercentage}%` }}
        />
      </div>

      {/* Stepper items */}
      <div className="grid grid-cols-4 gap-2">
        {STAGES.map((stage, idx) => {
          const stepStatus = getStageStatus(stage.id, idx);

          return (
            <div key={stage.id} className="flex flex-col items-center text-center">
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium mb-1.5 transition-colors ${
                  stepStatus === 'completed'
                    ? 'bg-emerald-100 text-emerald-800'
                    : stepStatus === 'active'
                    ? 'bg-[#142B4A] text-white'
                    : stepStatus === 'failed'
                    ? 'bg-red-100 text-red-800'
                    : 'bg-slate-100 text-slate-400'
                }`}
              >
                {stepStatus === 'completed' ? (
                  <Check className="w-3.5 h-3.5" />
                ) : stepStatus === 'active' ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : stepStatus === 'failed' ? (
                  <AlertCircle className="w-3.5 h-3.5" />
                ) : (
                  <Clock className="w-3.5 h-3.5" />
                )}
              </div>
              <span
                className={`text-[11px] leading-tight ${
                  stepStatus === 'active' || stepStatus === 'completed'
                    ? 'text-slate-800 font-medium'
                    : 'text-slate-400'
                }`}
              >
                {stage.label}
              </span>
            </div>
          );
        })}
      </div>

      {errorMessage && (
        <div className="mt-4 p-2.5 rounded bg-red-50 border border-red-200 text-xs text-red-700">
          <span className="font-semibold">Error:</span> {errorMessage}
        </div>
      )}
    </div>
  );
};
