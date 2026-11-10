import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  apiClient,
  setAuthTokens,
  getAccessToken,
  getRefreshToken,
  ApiError
} from '../api/client';

describe('Centralized API Client', () => {
  beforeEach(() => {
    setAuthTokens(null, null);
    vi.restoreAllMocks();
  });

  it('manages tokens in-memory without persistent localStorage exposure', () => {
    setAuthTokens('access-token-123', 'refresh-token-456');
    expect(getAccessToken()).toBe('access-token-123');
    expect(getRefreshToken()).toBe('refresh-token-456');

    setAuthTokens(null, null);
    expect(getAccessToken()).toBe(null);
    expect(getRefreshToken()).toBe(null);
  });

  it('extracts data payload from standard API success envelope', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        success: true,
        data: { id: 'org-123', name: 'Acme Technologies' }
      })
    });

    const result = await apiClient<{ id: string; name: string }>('/organizations');
    expect(result.id).toBe('org-123');
    expect(result.name).toBe('Acme Technologies');
  });

  it('transforms API error envelope into typed ApiError exception', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        success: false,
        error: {
          code: 'INVALID_GSTIN',
          message: 'The provided GSTIN is invalid'
        },
        requestId: 'req-abc-123'
      })
    });

    await expect(apiClient('/gst-registrations')).rejects.toThrow(ApiError);
    try {
      await apiClient('/gst-registrations');
    } catch (err: any) {
      expect(err.code).toBe('INVALID_GSTIN');
      expect(err.message).toBe('The provided GSTIN is invalid');
      expect(err.status).toBe(400);
      expect(err.requestId).toBe('req-abc-123');
    }
  });

  it('automatically attaches Authorization Bearer header when token is set', async () => {
    setAuthTokens('my-access-jwt', null);

    let capturedHeaders: Headers | undefined;
    global.fetch = vi.fn().mockImplementation((_url, init) => {
      capturedHeaders = init?.headers as Headers;
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ success: true, data: { status: 'ok' } })
      });
    });

    await apiClient('/auth/me');
    expect(capturedHeaders?.get('Authorization')).toBe('Bearer my-access-jwt');
  });

  it('deduplicates concurrent refreshSession calls into a single in-flight HTTP request', async () => {
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          success: true,
          data: {
            tokens: {
              accessToken: 'refreshed-access-token',
              refreshToken: 'refreshed-refresh-token'
            }
          }
        })
      };
    });

    const { refreshSession } = await import('../api/client');
    const [token1, token2, token3] = await Promise.all([
      refreshSession(),
      refreshSession(),
      refreshSession()
    ]);

    expect(callCount).toBe(1);
    expect(token1).toBe('refreshed-access-token');
    expect(token2).toBe('refreshed-access-token');
    expect(token3).toBe('refreshed-access-token');
    expect(getAccessToken()).toBe('refreshed-access-token');
  });

  it('refreshes token on 401 and retries original request', async () => {
    let requestNum = 0;
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      requestNum++;
      if (requestNum === 1) {
        // Initial request returns 401 ACCESS_TOKEN_EXPIRED
        return {
          ok: false,
          status: 401,
          headers: new Headers({ 'content-type': 'application/json' }),
          clone: () => ({
            json: async () => ({
              success: false,
              error: { code: 'ACCESS_TOKEN_EXPIRED', message: 'Token expired' }
            })
          })
        };
      }
      if (url.includes('/auth/refresh')) {
        // Refresh endpoint succeeds
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({
            success: true,
            data: { tokens: { accessToken: 'new-retry-token' } }
          })
        };
      }
      // Retried request succeeds
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          success: true,
          data: { profile: 'user-data' }
        })
      };
    });

    const res = await apiClient<{ profile: string }>('/protected-resource');
    expect(res.profile).toBe('user-data');
    expect(getAccessToken()).toBe('new-retry-token');
  });
});
