import type { CachedNote, NoteMeta, PendingOp } from '../types'
import { t } from '../i18n'

function makeClientOrigin(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export const clientOrigin = makeClientOrigin()

export function normalizeTs(value?: string | null): string {
  if (!value) return ''
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) return ''
  return new Date(ms).toISOString()
}

export function toMeta(note: CachedNote): NoteMeta {
  return {
    title: note.title,
    updatedAt: normalizeTs(note.updatedAt),
    dirty: Boolean(note.dirty),
    starred: Boolean(note.starred)
  }
}

export function tsMs(value?: string | null): number {
  if (!value) return 0
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? 0 : ms
}

export function newerTs(a?: string | null, b?: string | null): string {
  return tsMs(a) >= tsMs(b) ? normalizeTs(a) : normalizeTs(b)
}

export function isServerBacked(note?: CachedNote | null): boolean {
  return note?.existsOnServer !== false
}

export function samePendingOp(a: PendingOp, b: PendingOp): boolean {
  if (a.type !== b.type) return false
  if (a.type === 'rename' && b.type === 'rename') return a.oldTitle === b.oldTitle && a.newTitle === b.newTitle
  if (a.type === 'delete' && b.type === 'delete') return a.title === b.title
  if (a.type === 'star' && b.type === 'star') return a.title === b.title && a.starred === b.starred
  return false
}

export function retargetPendingTitle(ops: PendingOp[], fromTitle: string, toTitle: string): PendingOp[] {
  return ops.map((op) => {
    if (op.type === 'rename') {
      return {
        ...op,
        oldTitle: op.oldTitle === fromTitle ? toTitle : op.oldTitle,
        newTitle: op.newTitle === fromTitle ? toTitle : op.newTitle
      }
    }

    if (op.type === 'delete') {
      return { ...op, title: op.title === fromTitle ? toTitle : op.title }
    }

    return { ...op, title: op.title === fromTitle ? toTitle : op.title }
  })
}

export function resolveUniqueTitle(existing: Set<string>, baseTitle: string): string {
  if (!existing.has(baseTitle)) return baseTitle
  let i = 2
  while (existing.has(`${baseTitle} (${i})`)) i += 1
  return `${baseTitle} (${i})`
}

export function isNetworkError(err: unknown): boolean {
  if (!err) return false
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true

  const message = (err as Error)?.message || ''
  const normalized = message.toLowerCase()

  return (
    normalized.includes('failed to fetch') ||
    normalized.includes('networkerror') ||
    normalized.includes('network request failed') ||
    normalized.includes('load failed')
  )
}

export function isIndexedDbRuntimeError(err: unknown): boolean {
  if (!err) return false

  const name = (err as DOMException)?.name || ''
  if (name === 'UnknownError' || name === 'InvalidStateError' || name === 'TransactionInactiveError' || name === 'AbortError') {
    return true
  }

  const message = ((err as Error)?.message || '').toLowerCase()
  return (
    message.includes('without an in-progress transaction') ||
    message.includes('transaction is inactive or finished') ||
    message.includes('connection to indexed database server lost') ||
    message.includes('internal error was encountered in the indexed database server') ||
    message.includes('database connection is closing')
  )
}

export function toUserSyncError(err: unknown, fallback: string): string {
  if ((err as Error)?.message === 'UNAUTHORIZED') return 'UNAUTHORIZED'
  if (isNetworkError(err)) return t('temporaryConnectionIssue')
  if (isIndexedDbRuntimeError(err)) return t('couldNotSaveLocally')
  return (err as Error)?.message || fallback
}

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
