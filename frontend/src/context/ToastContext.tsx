import React, { createContext, useContext, useState, useCallback } from 'react';
import { CheckCircle2, AlertTriangle, AlertCircle, Info, X } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastMessage {
  id: string;
  type: ToastType;
  title?: string;
  message: string;
  duration?: number;
}

interface ToastContextValue {
  showToast: (message: string, type?: ToastType, title?: string, duration?: number) => void;
  removeToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback(
    (message: string, type: ToastType = 'info', title?: string, duration = 4000) => {
      const id = Math.random().toString(36).substring(2, 9);
      const newToast: ToastMessage = { id, type, title, message, duration };

      setToasts((prev) => [...prev, newToast]);

      if (duration > 0) {
        setTimeout(() => {
          removeToast(id);
        }, duration);
      }
    },
    [removeToast]
  );

  return (
    <ToastContext.Provider value={{ showToast, removeToast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none">
        {toasts.map((toast) => {
          const config = {
            success: {
              icon: <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />,
              border: 'border-emerald-200 bg-white text-emerald-950',
              badge: 'bg-emerald-50 text-emerald-700'
            },
            error: {
              icon: <AlertCircle className="w-5 h-5 text-red-600 shrink-0" />,
              border: 'border-red-200 bg-white text-red-950',
              badge: 'bg-red-50 text-red-700'
            },
            warning: {
              icon: <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />,
              border: 'border-amber-200 bg-white text-amber-950',
              badge: 'bg-amber-50 text-amber-700'
            },
            info: {
              icon: <Info className="w-5 h-5 text-blue-600 shrink-0" />,
              border: 'border-blue-200 bg-white text-blue-950',
              badge: 'bg-blue-50 text-blue-700'
            }
          }[toast.type];

          return (
            <div
              key={toast.id}
              role="alert"
              className={`pointer-events-auto flex items-start gap-3 p-3.5 rounded-lg border shadow-sm transition-all duration-200 ${config.border}`}
            >
              {config.icon}
              <div className="flex-1 text-sm">
                {toast.title && <div className="font-semibold text-slate-900 mb-0.5">{toast.title}</div>}
                <div className="text-slate-600 leading-relaxed text-xs">{toast.message}</div>
              </div>
              <button
                type="button"
                onClick={() => removeToast(toast.id)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded transition-colors"
                aria-label="Dismiss toast"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
};

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}
