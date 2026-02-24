import type { CachedNote, NoteMeta, PendingOp } from '../types'

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
