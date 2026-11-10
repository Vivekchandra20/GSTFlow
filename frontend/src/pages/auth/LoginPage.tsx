import React, { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Eye, EyeOff, ShieldCheck, ArrowRight } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Alert } from '../../components/ui/Alert';
import { extractErrorMessage } from '../../utils/errors';

const LoginSchema = z.object({
  email: z.string().min(1, 'Email is required').email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required')
});

type LoginFormValues = z.infer<typeof LoginSchema>;

export const LoginPage: React.FC = () => {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [showPassword, setShowPassword] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting }
  } = useForm<LoginFormValues>({
    resolver: zodResolver(LoginSchema)
  });

  const onSubmit = async (data: LoginFormValues) => {
    setApiError(null);
    try {
      await login(data);
      const fromPath = (location.state as any)?.from?.pathname;
      const fromSearch = (location.state as any)?.from?.search || '';
      if (fromPath) {
        navigate(fromPath + fromSearch);
      } else {
        navigate('/dashboard');
      }
    } catch (err: unknown) {
      setApiError(extractErrorMessage(err, 'Invalid email or password.'));
    }
  };

  return (
    <div className="min-h-screen bg-[#F5F7FA] flex flex-col justify-center py-12 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md text-center">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-[#142B4A] text-[#0F8B72] text-xl font-bold shadow-sm mb-4">
          GF
        </div>
        <h2 className="text-2xl font-bold tracking-tight text-[#142B4A]">
          Sign in to GSTFlow
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Multi-tenant GST reconciliation and statutory compliance platform
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
              label="Email address"
              type="email"
              autoComplete="email"
              placeholder="accountant@company.com"
              error={errors.email?.message}
              {...register('email')}
            />

            <Input
              label="Password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
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

            <Button
              type="submit"
              variant="primary"
              className="w-full mt-2"
              isLoading={isSubmitting}
              rightIcon={<ArrowRight className="w-4 h-4" />}
            >
              Sign in
            </Button>
          </form>

          <div className="mt-6 pt-6 border-t border-slate-100 flex items-center justify-between text-xs">
            <span className="text-slate-500">Don't have an account?</span>
            <Link
              to="/register"
              className="font-semibold text-[#0F8B72] hover:text-[#0B705D] transition-colors"
            >
              Create account
            </Link>
          </div>
        </div>

        <div className="mt-6 flex items-center justify-center gap-1.5 text-slate-400 text-[11px]">
          <ShieldCheck className="w-3.5 h-3.5 text-[#0F8B72]" />
          <span>Statutory row-level security & encrypted token storage</span>
        </div>
      </div>
    </div>
  );
};
