export interface ApiFailure { error?: { code?: string; message?: string; requestId?: string }; [key: string]: unknown }
export const WORKSPACE_EXPIRED_EVENT = 'palletdock:workspace-expired';
export type ApiError = Error & { status?: number; code?: string; body?: ApiFailure };

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/backend${path}`, {
    credentials: 'include',
    ...init,
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as ApiFailure;
    const error = new Error(body.error?.message ?? `Request failed with HTTP ${response.status}`) as ApiError;
    error.status = response.status;
    error.code = body.error?.code;
    error.body = body;
    // Any request can be the first to see a temporary workspace's expiry; the workspace shell listens.
    if (error.code === 'WORKSPACE_EXPIRED' && typeof window !== 'undefined') window.dispatchEvent(new Event(WORKSPACE_EXPIRED_EVENT));
    throw error;
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
