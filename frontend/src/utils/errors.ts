/**
 * Normalizes error messages from API envelope errors or client exceptions.
 */
export function extractErrorMessage(error: unknown, fallback = 'An unexpected error occurred'): string {
  if (!error) return fallback;

  if (typeof error === 'string') return error;

  if (typeof error === 'object' && error !== null) {
    const errObj = error as Record<string, any>;
    if (errObj.response?.data?.error?.message) {
      return errObj.response.data.error.message;
    }
    if (errObj.error?.message) {
      return errObj.error.message;
    }
    if (errObj.message) {
      return errObj.message;
    }
  }

  return fallback;
}
