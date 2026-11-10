import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { User } from '../api/types';
import { authApi, LoginPayload, RegisterPayload } from '../api/auth.api';
import { setAuthTokens, registerUnauthorizedCallback } from '../api/client';

interface AuthContextValue {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (payload: LoginPayload) => Promise<void>;
  register: (payload: RegisterPayload) => Promise<void>;
  logout: () => Promise<void>;
  reloadUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      setAuthTokens(null, null);
    } finally {
      setUser(null);
    }
  }, []);

  const reloadUser = useCallback(async () => {
    try {
      const res = await authApi.getMe();
      setUser(res.user);
    } catch {
      setUser(null);
      setAuthTokens(null, null);
    }
  }, []);

  useEffect(() => {
    // Listen for 401 unrecoverable session expiry
    registerUnauthorizedCallback(() => {
      setUser(null);
      setAuthTokens(null, null);
    });

    // Check existing session with automatic token refresh on reload
    const initAuth = async () => {
      try {
        // Step 1: restore access token via HTTP-only refresh cookie
        await authApi.refreshToken();
        // Step 2: fetch authenticated user profile
        const res = await authApi.getMe();
        setUser(res.user);
      } catch {
        setUser(null);
      } finally {
        setIsLoading(false);
      }
    };

    initAuth();
  }, []);

  const login = async (payload: LoginPayload) => {
    const res = await authApi.login(payload);
    setUser(res.user);
  };

  const register = async (payload: RegisterPayload) => {
    const res = await authApi.register(payload);
    setUser(res.user);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        isAuthenticated: !!user,
        login,
        register,
        logout,
        reloadUser
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
