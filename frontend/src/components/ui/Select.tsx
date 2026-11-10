import React from 'react';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  options: SelectOption[];
  error?: string;
  helperText?: string;
  placeholder?: string;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  (
    {
      label,
      options,
      error,
      helperText,
      placeholder,
      className = '',
      id,
      ...props
    },
    ref
  ) => {
    const selectId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);

    return (
      <div className="w-full flex flex-col gap-1.5">
        {label && (
          <label htmlFor={selectId} className="text-xs font-medium text-slate-700">
            {label}
            {props.required && <span className="text-red-500 ml-0.5">*</span>}
          </label>
        )}
        <select
          ref={ref}
          id={selectId}
          className={`w-full rounded-md border text-sm transition-colors duration-150 py-2 px-3 bg-white text-slate-900
            ${
              error
                ? 'border-red-300 focus:border-red-500 focus:ring-1 focus:ring-red-500'
                : 'border-slate-300 hover:border-slate-400 focus:border-[#142B4A] focus:ring-1 focus:ring-[#142B4A]'
            }
            disabled:bg-slate-50 disabled:text-slate-500 disabled:cursor-not-allowed
            ${className}
          `}
          {...props}
        >
          {placeholder && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {options.map((opt) => (
            <option key={opt.value} value={opt.value} disabled={opt.disabled}>
              {opt.label}
            </option>
          ))}
        </select>
        {error && <span className="text-xs text-red-600 font-medium">{error}</span>}
        {!error && helperText && <span className="text-xs text-slate-500">{helperText}</span>}
      </div>
    );
  }
);

Select.displayName = 'Select';
