import type { CachedNote, NoteMeta, PendingOp } from '../types'

export function normalizeTs(value?: string | null): string {
  if (!value) return ''
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) return ''
  return new Date(ms).toISOString()
}

export function normalizeCollection(value?: string | null): string {
  return (value || '').trim()
}

export function buildNoteKey(title: string, collection?: string | null): string {
  const normalizedCollection = normalizeCollection(collection)
  return normalizedCollection ? `${normalizedCollection}/${title}` : title
}

export function splitNoteKey(key: string): { title: string; collection: string } {
  const normalized = (key || '').trim()
  if (!normalized) return { title: '', collection: '' }

  const slashIdx = normalized.indexOf('/')
  if (slashIdx === -1) {
    return { title: normalized, collection: '' }
  }

  return {
    collection: normalized.slice(0, slashIdx),
    title: normalized.slice(slashIdx + 1)
  }
}

export function normalizeNoteKey(note: Pick<NoteMeta, 'key' | 'title' | 'collection'>): string {
  if (note.key) return note.key
  return buildNoteKey(note.title, note.collection)
}

export function toMeta(note: CachedNote): NoteMeta {
  return {
    key: normalizeNoteKey(note),
    title: note.title,
    collection: normalizeCollection(note.collection),
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
  if (a.type === 'rename' && b.type === 'rename') return a.oldKey === b.oldKey && a.newKey === b.newKey
  if (a.type === 'delete' && b.type === 'delete') return a.key === b.key
  if (a.type === 'star' && b.type === 'star') return a.key === b.key && a.starred === b.starred
  return false
}

export function retargetPendingKey(ops: PendingOp[], fromKey: string, toKey: string): PendingOp[] {
  return ops.map((op) => {
    if (op.type === 'rename') {
      return {
        ...op,
        oldKey: op.oldKey === fromKey ? toKey : op.oldKey,
        newKey: op.newKey === fromKey ? toKey : op.newKey
      }
    }

    if (op.type === 'delete') {
      return { ...op, key: op.key === fromKey ? toKey : op.key }
    }

    return { ...op, key: op.key === fromKey ? toKey : op.key }
  })
}

export function resolveUniqueTitle(existing: Set<string>, baseTitle: string): string {
  if (!existing.has(baseTitle)) return baseTitle
  let i = 2
  while (existing.has(`${baseTitle} (${i})`)) i += 1
  return `${baseTitle} (${i})`
}
