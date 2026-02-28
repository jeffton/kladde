import type { Ref } from 'vue'
import type { CachedNote, NoteMeta } from '../types'

interface NotesPersistDeps {
  selectedKey: Ref<string>
  currentContent: Ref<string>
  currentUpdatedAt: Ref<string | null>
  dirty: Ref<boolean>
  contentVersion: Ref<number>
  notes: Ref<NoteMeta[]>
  noteContents: Ref<Record<string, string>>
  getCachedNote: (key: string) => Promise<CachedNote | undefined>
  putCachedNote: (note: CachedNote) => Promise<IDBValidKey>
  updateSyncStatus: () => void
  onPersistError: (err: unknown) => void
}

export function createNotesPersist(deps: NotesPersistDeps) {
  const contentPersistDelayMs = 120
  let pendingContentSnapshot: CachedNote | null = null
  let contentPersistTimer: number | null = null
  let writeQueue: Promise<unknown> = Promise.resolve()

  const queueWrite = (task: () => Promise<unknown>) => {
    const run = writeQueue.then(() => task())
    writeQueue = run.catch(() => undefined)
    return run
  }

  const persistLatestContentSnapshot = async () => {
    const snapshot = pendingContentSnapshot
    if (!snapshot) return
    pendingContentSnapshot = null

    await queueWrite(async () => {
      const existing = await deps.getCachedNote(snapshot.key)
      await deps.putCachedNote({
        ...snapshot,
        existsOnServer: existing?.existsOnServer
      })
      if (deps.selectedKey.value === snapshot.key && deps.contentVersion.value === snapshot.version) {
        deps.updateSyncStatus()
      }
    })
  }

  const scheduleContentPersist = () => {
    if (contentPersistTimer !== null) return

    contentPersistTimer = window.setTimeout(() => {
      contentPersistTimer = null
      void persistLatestContentSnapshot().catch((err) => {
        deps.onPersistError(err)
      })
    }, contentPersistDelayMs)
  }

  const flushPendingWrites = async () => {
    if (contentPersistTimer !== null) {
      window.clearTimeout(contentPersistTimer)
      contentPersistTimer = null
    }

    await persistLatestContentSnapshot()
    await writeQueue
  }

  const setCurrentContent = async (content: string) => {
    deps.currentContent.value = content
    deps.dirty.value = true
    const nowIso = new Date().toISOString()
    deps.currentUpdatedAt.value = nowIso
    deps.contentVersion.value += 1

    if (!deps.selectedKey.value) return

    const selectedMeta = deps.notes.value.find((n) => n.key === deps.selectedKey.value)
    if (selectedMeta) {
      selectedMeta.dirty = true
      selectedMeta.updatedAt = nowIso
    }

    deps.noteContents.value = {
      ...deps.noteContents.value,
      [deps.selectedKey.value]: deps.currentContent.value
    }

    const fallback = deps.selectedKey.value.includes('/')
      ? { collection: deps.selectedKey.value.split('/')[0], title: deps.selectedKey.value.split('/').slice(1).join('/') }
      : { collection: '', title: deps.selectedKey.value }

    pendingContentSnapshot = {
      key: deps.selectedKey.value,
      title: selectedMeta?.title || fallback.title,
      collection: selectedMeta?.collection || fallback.collection,
      content: deps.currentContent.value,
      updatedAt: nowIso,
      dirty: true,
      version: deps.contentVersion.value,
      starred: selectedMeta?.starred
    }

    scheduleContentPersist()
  }

  return {
    queueWrite,
    flushPendingWrites,
    setCurrentContent
  }
}
