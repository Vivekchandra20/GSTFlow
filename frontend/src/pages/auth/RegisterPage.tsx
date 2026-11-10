import React, { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Eye, EyeOff, ShieldCheck, Check } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Alert } from '../../components/ui/Alert';
import { extractErrorMessage } from '../../utils/errors';

const RegisterSchema = z
  .object({
    email: z.string().min(1, 'Email is required').email('Enter a valid email address'),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .regex(/[A-Z]/, 'Must contain at least 1 uppercase letter')
      .regex(/[a-z]/, 'Must contain at least 1 lowercase letter')
      .regex(/[0-9]/, 'Must contain at least 1 number'),
    confirmPassword: z.string().min(1, 'Please confirm your password')
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword']
  });

type RegisterFormValues = z.infer<typeof RegisterSchema>;

export const RegisterPage: React.FC = () => {
  const { register: registerAuth } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [showPassword, setShowPassword] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting }
  } = useForm<RegisterFormValues>({
    resolver: zodResolver(RegisterSchema)
  });

  const passwordValue = watch('password', '');

  const hasMinLength = passwordValue.length >= 8;
  const hasUppercase = /[A-Z]/.test(passwordValue);
  const hasNumber = /[0-9]/.test(passwordValue);

  const onSubmit = async (data: RegisterFormValues) => {
    setApiError(null);
    try {
      await registerAuth({ email: data.email, password: data.password });
      const fromPath = (location.state as any)?.from?.pathname;
      const fromSearch = (location.state as any)?.from?.search || '';
      if (fromPath) {
        navigate(fromPath + fromSearch);
      } else {
        navigate('/onboarding');
      }
    } catch (err: unknown) {
      setApiError(extractErrorMessage(err, 'Unable to create account.'));
    }
  };

  return (
    <div className="min-h-screen bg-[#F5F7FA] flex flex-col justify-center py-12 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md text-center">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-[#142B4A] text-[#0F8B72] text-xl font-bold shadow-sm mb-4">
          GF
        </div>
        <h2 className="text-2xl font-bold tracking-tight text-[#142B4A]">
          Create your GSTFlow account
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Start reconciling Indian marketplace MTR reports with precision
        </p>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md px-4">
        <div className="bg-white py-8 px-6 shadow-sm border border-slate-200 rounded-xl sm:px-10">
          {apiError && (
            <Alert type="error" className="mb-5">
              {apiError}
            </Alert>
          )}

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <Input
              label="Work email address"
              type="email"
              autoComplete="email"
              placeholder="accountant@company.com"
              error={errors.email?.message}
              {...register('email')}
            />

            <Input
              label="Password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              placeholder="••••••••••••"
              error={errors.password?.message}
              rightIcon={
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="hover:text-slate-600 focus:outline-none"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              }
              {...register('password')}
            />

            {/* Password requirements checklist */}
            <div className="bg-slate-50 p-3 rounded-md border border-slate-100 text-[11px] space-y-1">
              <div className={`flex items-center gap-1.5 ${hasMinLength ? 'text-emerald-700' : 'text-slate-500'}`}>
                <Check className={`w-3.5 h-3.5 ${hasMinLength ? 'text-emerald-600' : 'text-slate-300'}`} />
                <span>At least 8 characters</span>
              </div>
              <div className={`flex items-center gap-1.5 ${hasUppercase ? 'text-emerald-700' : 'text-slate-500'}`}>
                <Check className={`w-3.5 h-3.5 ${hasUppercase ? 'text-emerald-600' : 'text-slate-300'}`} />
                <span>At least 1 uppercase letter</span>
              </div>
              <div className={`flex items-center gap-1.5 ${hasNumber ? 'text-emerald-700' : 'text-slate-500'}`}>
                <Check className={`w-3.5 h-3.5 ${hasNumber ? 'text-emerald-600' : 'text-slate-300'}`} />
                <span>At least 1 number</span>
              </div>
            </div>

            <Input
              label="Confirm password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              placeholder="••••••••••••"
              error={errors.confirmPassword?.message}
              {...register('confirmPassword')}
            />

            <Button type="submit" variant="primary" className="w-full mt-2" isLoading={isSubmitting}>
              Create account
            </Button>
          </form>

          <div className="mt-6 pt-6 border-t border-slate-100 flex items-center justify-between text-xs">
            <span className="text-slate-500">Already registered?</span>
            <Link
              to="/login"
              className="font-semibold text-[#0F8B72] hover:text-[#0B705D] transition-colors"
            >
              Sign in
            </Link>
          </div>
        </div>

        <div className="mt-6 flex items-center justify-center gap-1.5 text-slate-400 text-[11px]">
          <ShieldCheck className="w-3.5 h-3.5 text-[#0F8B72]" />
          <span>Tenant isolation enforced with PostgreSQL Row-Level Security</span>
        </div>
      </div>
    </div>
  );
};
