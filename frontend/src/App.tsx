import React from 'react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from './context/AuthContext';
import { OrgProvider } from './context/OrgContext';
import { ToastProvider } from './context/ToastContext';
import { AppRouter } from './router';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error: any) => {
        // Do not retry 401, 403, or 404
        if (error?.status === 401 || error?.status === 403 || error?.status === 404) {
          return false;
        }
        return failureCount < 2;
      },
      refetchOnWindowFocus: false,
      staleTime: 1000 * 30 // 30 seconds
    }
  }
});

export const App: React.FC = () => {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <OrgProvider>
            <ToastProvider>
              <AppRouter />
            </ToastProvider>
          </OrgProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
};

export default App;
