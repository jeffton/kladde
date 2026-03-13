import { t } from '../i18n'

export const UNAUTHORIZED_EVENT = 'kladde:unauthorized'

export function isUnauthorizedError(err: unknown): boolean {
  return (err as Error)?.message === 'UNAUTHORIZED'
}

export function emitUnauthorizedEvent() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
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
    normalized.includes('load failed') ||
    normalized.includes('request_timeout') ||
    normalized.includes('timeout')
  )
}

export function isIndexedDbRuntimeError(err: unknown): boolean {
  if (!err) return false

  const name = (err as DOMException)?.name || ''
  if (
    name === 'UnknownError' ||
    name === 'InvalidStateError' ||
    name === 'TransactionInactiveError' ||
    name === 'AbortError'
  ) {
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
  if (isUnauthorizedError(err)) return 'UNAUTHORIZED'
  if (isNetworkError(err)) return t('temporaryConnectionIssue')
  if (isIndexedDbRuntimeError(err)) return t('couldNotSaveLocally')
  return (err as Error)?.message || fallback
}
