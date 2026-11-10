import { apiClient, setAuthTokens, refreshSession } from './client';
import { AuthResult, User } from './types';

export interface RegisterPayload {
  email: string;
  password: string;
}

export interface LoginPayload {
  email: string;
  password: string;
}

export const authApi = {
  async register(payload: RegisterPayload): Promise<AuthResult> {
    const data = await apiClient<AuthResult>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload),
      skipAuth: true
    });
    setAuthTokens(data.tokens.accessToken, data.tokens.refreshToken);
    return data;
  },

  async login(payload: LoginPayload): Promise<AuthResult> {
    const data = await apiClient<AuthResult>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
      skipAuth: true
    });
    setAuthTokens(data.tokens.accessToken, data.tokens.refreshToken);
    return data;
  },

  async refreshToken(forcedToken?: string): Promise<string> {
    return refreshSession(forcedToken);
  },

  async getMe(): Promise<{ user: User }> {
    return apiClient<{ user: User }>('/auth/me');
  },

  async logout(refreshToken?: string): Promise<{ message: string }> {
    try {
      const res = await apiClient<{ message: string }>('/auth/logout', {
        method: 'POST',
        body: JSON.stringify(refreshToken ? { refreshToken } : {})
      });
      return res;
    } finally {
      setAuthTokens(null, null);
    }
  }
};
