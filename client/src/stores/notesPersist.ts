import type { Ref } from 'vue'
import type { CachedNote, NoteMeta } from '../types'

interface NotesPersistDeps {
  selectedTitle: Ref<string>
  currentContent: Ref<string>
  currentUpdatedAt: Ref<string | null>
  dirty: Ref<boolean>
  contentVersion: Ref<number>
  notes: Ref<NoteMeta[]>
  noteContents: Ref<Record<string, string>>
  getCachedNote: (title: string) => Promise<CachedNote | undefined>
  putCachedNote: (note: CachedNote) => Promise<IDBValidKey>
  updateSyncStatus: () => void
}

export function createNotesPersist(deps: NotesPersistDeps) {
  const contentPersistDelayMs = 120
  let pendingContentSnapshot: CachedNote | null = null
  let contentPersistTimer: number | null = null
  let writeQueue: Promise<unknown> = Promise.resolve()

  const queueWrite = (task: () => Promise<unknown>) => {
    writeQueue = writeQueue.then(task).catch(() => undefined)
    return writeQueue
  }

  const persistLatestContentSnapshot = async () => {
    const snapshot = pendingContentSnapshot
    if (!snapshot) return
    pendingContentSnapshot = null

    await queueWrite(async () => {
      const existing = await deps.getCachedNote(snapshot.title)
      await deps.putCachedNote({
        ...snapshot,
        existsOnServer: existing?.existsOnServer
      })
      if (deps.selectedTitle.value === snapshot.title && deps.contentVersion.value === snapshot.version) {
        deps.updateSyncStatus()
      }
    })
  }

  const scheduleContentPersist = () => {
    if (contentPersistTimer !== null) return

    contentPersistTimer = window.setTimeout(() => {
      contentPersistTimer = null
      void persistLatestContentSnapshot().catch(() => undefined)
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

    if (!deps.selectedTitle.value) return

    const selectedMeta = deps.notes.value.find((n) => n.title === deps.selectedTitle.value)
    if (selectedMeta) {
      selectedMeta.dirty = true
      selectedMeta.updatedAt = nowIso
    }

    deps.noteContents.value = {
      ...deps.noteContents.value,
      [deps.selectedTitle.value]: deps.currentContent.value
    }

    pendingContentSnapshot = {
      title: deps.selectedTitle.value,
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
