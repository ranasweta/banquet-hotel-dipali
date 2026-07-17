/**
 * Browser-side fetch wrapper for the /api/v1 surface. Unwraps the JSON body and turns a
 * non-2xx `{ error: { message } }` into a thrown Error, so callers can try/catch.
 */
export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } }
  if (!res.ok) {
    throw new Error(body?.error?.message ?? `Request failed (${res.status})`)
  }
  return body as T
}
