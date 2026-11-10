import React from 'react';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  helperText?: string;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  isMonospace?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    {
      label,
      error,
      helperText,
      leftIcon,
      rightIcon,
      isMonospace = false,
      className = '',
      id,
      ...props
    },
    ref
  ) => {
    const inputId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);

    return (
      <div className="w-full flex flex-col gap-1.5">
        {label && (
          <label htmlFor={inputId} className="text-xs font-medium text-slate-700">
            {label}
            {props.required && <span className="text-red-500 ml-0.5">*</span>}
          </label>
        )}
        <div className="relative flex items-center">
          {leftIcon && (
            <div className="absolute left-3 flex items-center pointer-events-none text-slate-400">
              {leftIcon}
            </div>
          )}
          <input
            ref={ref}
            id={inputId}
            className={`w-full rounded-md border text-sm transition-colors duration-150 py-2 bg-white text-slate-900 placeholder:text-slate-400
              ${leftIcon ? 'pl-9' : 'pl-3'}
              ${rightIcon ? 'pr-9' : 'pr-3'}
              ${isMonospace ? 'font-mono text-xs tracking-wide' : 'font-sans'}
              ${
                error
                  ? 'border-red-300 focus:border-red-500 focus:ring-1 focus:ring-red-500'
                  : 'border-slate-300 hover:border-slate-400 focus:border-[#142B4A] focus:ring-1 focus:ring-[#142B4A]'
              }
              disabled:bg-slate-50 disabled:text-slate-500 disabled:cursor-not-allowed
              ${className}
            `}
            {...props}
          />
          {rightIcon && (
            <div className="absolute right-3 flex items-center text-slate-400">
              {rightIcon}
            </div>
          )}
        </div>
        {error && <span className="text-xs text-red-600 font-medium">{error}</span>}
        {!error && helperText && <span className="text-xs text-slate-500">{helperText}</span>}
      </div>
    );
  }
);

Input.displayName = 'Input';
