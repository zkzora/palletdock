export interface ApiFailure { error?: { code?: string; message?: string; requestId?: string } }

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/backend${path}`, {
    credentials: 'include',
    ...init,
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as ApiFailure;
    const error = new Error(body.error?.message ?? `Request failed with HTTP ${response.status}`) as Error & { status?: number; code?: string };
    error.status = response.status;
    error.code = body.error?.code;
    throw error;
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
