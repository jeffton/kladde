import { t } from '../i18n'

function makeClientOrigin(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export const clientOrigin = makeClientOrigin()

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export function isNotFoundError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404
}

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const method = ((init?.method || (input instanceof Request ? input.method : 'GET')) || 'GET').toUpperCase()
  let requestInit = init

  if (method !== 'GET' && method !== 'HEAD') {
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    if (init?.headers) {
      const extra = new Headers(init.headers)
      extra.forEach((value, key) => headers.set(key, value))
    }
    headers.set('X-Kladde-Origin', clientOrigin)
    requestInit = { ...init, headers }
  }

  const res = await fetch(input, requestInit)

  if (res.status === 401) {
    throw new Error('UNAUTHORIZED')
  }

  if (!res.ok) {
    let message = t('requestFailed')
    try {
      const payload = (await res.json()) as { error?: string }
      if (payload?.error) message = payload.error
    } catch {
      // no-op
    }
    throw new ApiError(res.status, message)
  }

  return res
}
