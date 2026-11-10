import React from 'react';
import { Loader2 } from 'lucide-react';

export type ButtonVariant = 'primary' | 'accent' | 'secondary' | 'outline' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  isLoading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      children,
      variant = 'primary',
      size = 'md',
      isLoading = false,
      disabled,
      leftIcon,
      rightIcon,
      className = '',
      type = 'button',
      ...props
    },
    ref
  ) => {
    const baseStyles =
      'inline-flex items-center justify-center font-medium transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-offset-1 select-none disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer';

    const sizeStyles = {
      sm: 'text-xs px-2.5 py-1.5 rounded-md gap-1.5',
      md: 'text-sm px-3.5 py-2 rounded-md gap-2',
      lg: 'text-base px-5 py-2.5 rounded-lg gap-2.5'
    }[size];

    const variantStyles = {
      primary:
        'bg-[#142B4A] hover:bg-[#1C3B61] active:bg-[#0E1E34] text-white focus:ring-[#142B4A]/50 border border-transparent shadow-xs',
      accent:
        'bg-[#0F8B72] hover:bg-[#0B705D] active:bg-[#085547] text-white focus:ring-[#0F8B72]/50 border border-transparent shadow-xs',
      secondary:
        'bg-white hover:bg-slate-50 active:bg-slate-100 text-[#172B4D] border border-slate-200 focus:ring-slate-300 shadow-xs',
      outline:
        'bg-transparent hover:bg-slate-100 text-[#172B4D] border border-slate-300 focus:ring-slate-300',
      danger:
        'bg-red-600 hover:bg-red-700 active:bg-red-800 text-white focus:ring-red-500 border border-transparent shadow-xs',
      ghost:
        'bg-transparent hover:bg-slate-100 active:bg-slate-200 text-slate-700 focus:ring-slate-300'
    }[variant];

    return (
      <button
        ref={ref}
        type={type}
        disabled={disabled || isLoading}
        className={`${baseStyles} ${sizeStyles} ${variantStyles} ${className}`}
        {...props}
      >
        {isLoading && <Loader2 className="w-4 h-4 animate-spin shrink-0" />}
        {!isLoading && leftIcon && <span className="shrink-0">{leftIcon}</span>}
        <span>{children}</span>
        {!isLoading && rightIcon && <span className="shrink-0">{rightIcon}</span>}
      </button>
    );
  }
);

Button.displayName = 'Button';
