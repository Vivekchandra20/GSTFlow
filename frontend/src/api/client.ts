import { ApiErrorResponse, ApiSuccessResponse } from './types';

export class ApiError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly details?: unknown[];
  public readonly requestId?: string;

  constructor(message: string, code: string, status: number, details?: unknown[], requestId?: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.requestId = requestId;
  }
}

// In-memory token management (Prevents XSS extraction of persistent access tokens)
let inMemoryAccessToken: string | null = null;
let inMemoryRefreshToken: string | null = null;
let unauthorizedCallback: (() => void) | null = null;
let activeRefreshPromise: Promise<string> | null = null;

export function setAuthTokens(accessToken: string | null, refreshToken?: string | null): void {
  inMemoryAccessToken = accessToken;
  if (refreshToken !== undefined) {
    inMemoryRefreshToken = refreshToken;
  }
}

export function getAccessToken(): string | null {
  return inMemoryAccessToken;
}

export function getRefreshToken(): string | null {
  return inMemoryRefreshToken;
}

export function registerUnauthorizedCallback(cb: () => void): void {
  unauthorizedCallback = cb;
}

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api/v1';

/**
 * Thread-safe session refresh executing a single in-flight refresh request.
 * Resolves with the new access token.
 */
export async function refreshSession(forcedToken?: string): Promise<string> {
  if (activeRefreshPromise) {
    return activeRefreshPromise;
  }

  activeRefreshPromise = (async () => {
    try {
      const tokenToSend = forcedToken || inMemoryRefreshToken;
      const payload = tokenToSend ? { refreshToken: tokenToSend } : {};

      const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        let errorData: ApiErrorResponse | null = null;
        try {
          errorData = (await response.json()) as ApiErrorResponse;
        } catch {
          // not json
        }
        setAuthTokens(null, null);
        unauthorizedCallback?.();
        throw new ApiError(
          errorData?.error?.message || 'Session expired. Please sign in again.',
          errorData?.error?.code || 'SESSION_EXPIRED',
          response.status,
          errorData?.error?.details,
          errorData?.requestId
        );
      }

      const refreshData = (await response.json()) as ApiSuccessResponse<{
        tokens: { accessToken: string; refreshToken?: string };
      }>;
      const newToken = refreshData.data.tokens.accessToken;
      setAuthTokens(newToken, refreshData.data.tokens.refreshToken);
      return newToken;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'NETWORK_ERROR') {
        throw err;
      }
      if (err instanceof TypeError) {
        throw new ApiError('Unable to connect to server during session refresh.', 'NETWORK_ERROR', 0);
      }
      throw err;
    } finally {
      activeRefreshPromise = null;
    }
  })();

  return activeRefreshPromise;
}

export interface RequestOptions extends RequestInit {
  params?: Record<string, string | number | boolean | undefined | null>;
  skipAuth?: boolean;
}

/**
 * Universal typed API client for GSTFlow REST endpoints.
 */
export async function apiClient<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
  const { params, skipAuth = false, headers: customHeaders, ...fetchOptions } = options;

  let url = `${API_BASE_URL}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;

  if (params) {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, val]) => {
      if (val !== undefined && val !== null && val !== '') {
        searchParams.append(key, String(val));
      }
    });
    const queryString = searchParams.toString();
    if (queryString) {
      url += (url.includes('?') ? '&' : '?') + queryString;
    }
  }

  const headers = new Headers(customHeaders);
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json');
  }

  // Auto-set Content-Type for JSON payloads only when a body is provided (skip for FormData or bodyless requests)
  if (fetchOptions.body !== undefined && !(fetchOptions.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  // Attach Bearer Access Token if present and not skipped
  if (!skipAuth && inMemoryAccessToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${inMemoryAccessToken}`);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...fetchOptions,
      headers,
      credentials: 'include' // Always send cookies for same-site refresh flow
    });
  } catch (netErr) {
    throw new ApiError('Unable to connect to GSTFlow server. Please check your connection.', 'NETWORK_ERROR', 0);
  }

  // Handle Token Expiry & Automatic Refresh Flow (401)
  if (response.status === 401 && !skipAuth) {
    let errorData: ApiErrorResponse | null = null;
    try {
      errorData = (await response.clone().json()) as ApiErrorResponse;
    } catch {
      // not json
    }

    const errorCode = errorData?.error?.code;
    if (
      errorCode === 'ACCESS_TOKEN_EXPIRED' ||
      errorCode === 'INVALID_ACCESS_TOKEN' ||
      errorCode === 'UNAUTHENTICATED'
    ) {
      try {
        const newToken = await refreshSession();
        headers.set('Authorization', `Bearer ${newToken}`);
        const retryRes = await fetch(url, {
          ...fetchOptions,
          headers,
          credentials: 'include'
        });
        return handleResponse<T>(retryRes);
      } catch (refreshErr) {
        throw refreshErr;
      }
    }
  }

  return handleResponse<T>(response);
}

async function handleResponse<T>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type');
  const isJson = contentType && contentType.includes('application/json');

  if (!response.ok) {
    if (isJson) {
      const errPayload = (await response.json()) as ApiErrorResponse;
      throw new ApiError(
        errPayload.error?.message || `Request failed with status ${response.status}`,
        errPayload.error?.code || 'UNKNOWN_ERROR',
        response.status,
        errPayload.error?.details,
        errPayload.requestId
      );
    }
    const text = await response.text();
    throw new ApiError(text || `Request failed with status ${response.status}`, 'HTTP_ERROR', response.status);
  }

  if (response.status === 204) {
    return {} as T;
  }

  if (isJson) {
    const json = await response.json();
    // Return extracted data payload if envelope format is used
    if (json && typeof json === 'object' && 'success' in json && json.success === true && 'data' in json) {
      return json.data as T;
    }
    return json as T;
  }

  return (await response.text()) as unknown as T;
}
