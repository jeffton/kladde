import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { deleteCachedNote, getAllCachedNotes, getCachedNote, getPendingOps, putCachedNote, replacePendingOps } from './notesDb'
import type { CachedNote, NoteMeta, NoteResponse, PendingOp, SyncState } from '../types'
import { t } from '../i18n'
import { apiFetch, clientOrigin, isNotFoundError } from './notesApi'
import { createNotesWebSocket } from './notesWebSocket'
import { createNotesPersist } from './notesPersist'
import { createNotesSync } from './notesSync'
import { isNetworkError, toUserSyncError } from './notesErrors'
import {
  isServerBacked,
  newerTs,
  normalizeTs,
  resolveUniqueTitle,
  retargetPendingTitle,
  samePendingOp,
  toMeta,
  tsMs
} from './notesModel'

export const useNotesStore = defineStore('notes', () => {
  const notes = ref<NoteMeta[]>([])
  const selectedTitle = ref('')
  const currentContent = ref('')
  const currentUpdatedAt = ref<string | null>(null)
  const pinned = computed(() => new Set(notes.value.filter((n) => n.starred).map((n) => n.title)))
  const dirty = ref(false)
  const online = ref(navigator.onLine)
  const syncStatus = ref(t('syncedShort'))
  const syncing = ref(false)
  const syncError = ref('')
  const syncState = computed<SyncState>(() => {
    if (!online.value) return 'offline'
    if (syncing.value) return 'syncing'
    if (syncError.value) return 'error'
    return 'synced'
  })
  const contentVersion = ref(0)
  const noteContents = ref<Record<string, string>>({})
  const pendingOps = ref<PendingOp[]>([])
  let syncRetryTimer: number | null = null
  let syncRetryAttempt = 0
  const wsConnected = ref(false)

  const sortedNotes = computed(() => {
    return [...notes.value].sort((a, b) => {
      const aPinned = pinned.value.has(a.title)
      const bPinned = pinned.value.has(b.title)
      if (aPinned !== bPinned) return aPinned ? -1 : 1
      return tsMs(b.updatedAt) - tsMs(a.updatedAt)
    })
  })

  const isActiveNoteLocallyDirty = (title: string) => {
    return selectedTitle.value === title && dirty.value
  }

  const updateSyncStatus = () => {
    switch (syncState.value) {
      case 'offline':
        syncStatus.value = t('syncOfflineLocal')
        break
      case 'syncing':
        syncStatus.value = t('syncingShort')
        break
      case 'error':
        syncStatus.value = `${t('syncErrorPrefix')}: ${syncError.value}`
        break
      default:
        syncStatus.value = t('syncedShort')
    }
  }

  const setSyncError = (message: string) => {
    syncError.value = message || t('unknownError')
    updateSyncStatus()
  }

  const handleSyncFailure = (err: unknown, fallback: string) => {
    if (isNetworkError(err) && (typeof navigator !== 'undefined' && !navigator.onLine)) {
      online.value = false
      clearSyncError()
      updateSyncStatus()
      return
    }

    setSyncError(toUserSyncError(err, fallback))
    if (isNetworkError(err)) scheduleSyncRetry()
  }

  const clearSyncError = () => {
    syncError.value = ''
    updateSyncStatus()
  }

  const clearSyncRetry = () => {
    if (syncRetryTimer !== null) {
      window.clearTimeout(syncRetryTimer)
      syncRetryTimer = null
    }
    syncRetryAttempt = 0
  }

  const scheduleSyncRetry = () => {
    if (!online.value || syncRetryTimer !== null) return
    const baseDelay = 2000
    const maxDelay = 60000
    const expDelay = Math.min(maxDelay, baseDelay * 2 ** syncRetryAttempt)
    const jitter = Math.floor(Math.random() * 500)
    const delay = expDelay + jitter

    syncRetryTimer = window.setTimeout(() => {
      syncRetryTimer = null
      void syncWithServer().catch(() => undefined)
    }, delay)

    syncRetryAttempt = Math.min(syncRetryAttempt + 1, 8)
  }

  const { queueWrite, flushPendingWrites, setCurrentContent } = createNotesPersist({
    selectedTitle,
    currentContent,
    currentUpdatedAt,
    dirty,
    contentVersion,
    notes,
    noteContents,
    getCachedNote,
    putCachedNote,
    updateSyncStatus
  })

  const setOnline = (value: boolean) => {
    online.value = value
    updateSyncStatus()
    if (value) {
      clearSyncRetry()
      void syncWithServer().catch(() => undefined)
      void connectWebSocket()
      return
    }
    clearSyncRetry()
    disconnectWebSocket()
  }

  const togglePin = async (title: string) => {
    const note = notes.value.find((n) => n.title === title)
    if (!note) return

    const nextStarred = !Boolean(note.starred)
    note.starred = nextStarred

    await queueWrite(async () => {
      const cached = await getCachedNote(title)
      if (!cached) return
      await putCachedNote({ ...cached, starred: nextStarred })
    })

    await mutatePendingOps((ops) => {
      if (ops.some((op) => op.type === 'delete' && op.title === title)) return ops

      const next = [...ops]
      const existingIdx = next.findIndex((op) => op.type === 'star' && op.title === title)
      if (existingIdx === -1) {
        next.push({ type: 'star', title, starred: nextStarred })
      } else {
        next[existingIdx] = { type: 'star', title, starred: nextStarred }
      }
      return next
    })

    if (online.value) {
      void syncWithServer().catch(() => undefined)
    }
  }

  const refreshStateFromCache = async () => {
    const cached = await getAllCachedNotes()
    const activeTitle = selectedTitle.value
    const cachedByTitle = new Map(cached.map((n) => [n.title, n]))

    const newNotes = cached.filter((n) => n.title !== activeTitle).map(toMeta)
    const newNoteContents: Record<string, string> = Object.fromEntries(
      cached.filter((n) => n.title !== activeTitle).map((n) => [n.title, n.content || ''])
    )

    if (activeTitle) {
      const inMemoryActive = notes.value.find((n) => n.title === activeTitle)
      const cachedActive = cachedByTitle.get(activeTitle)
      const isLocallyDirty = dirty.value || Boolean(inMemoryActive?.dirty)
      const cachedUpdatedAt = normalizeTs(cachedActive?.updatedAt)
      const inMemoryUpdatedAt = normalizeTs(currentUpdatedAt.value)

      const activeMeta: NoteMeta | null = inMemoryActive
        ? {
            ...inMemoryActive,
            dirty: isLocallyDirty,
            updatedAt: isLocallyDirty ? inMemoryUpdatedAt || cachedUpdatedAt : cachedUpdatedAt || inMemoryUpdatedAt
          }
        : {
            title: activeTitle,
            updatedAt: isLocallyDirty ? inMemoryUpdatedAt || cachedUpdatedAt : cachedUpdatedAt || inMemoryUpdatedAt,
            dirty: isLocallyDirty || Boolean(cachedActive?.dirty),
            starred: Boolean(cachedActive?.starred)
          }

      if (activeMeta) newNotes.push(activeMeta)

      newNoteContents[activeTitle] = isLocallyDirty
        ? noteContents.value[activeTitle] ?? currentContent.value ?? cachedActive?.content ?? ''
        : cachedActive?.content ?? currentContent.value ?? noteContents.value[activeTitle] ?? ''
    }

    notes.value = newNotes
    noteContents.value = newNoteContents

    if (!selectedTitle.value && cached.length > 0) {
      selectedTitle.value = cached.sort((a, b) => tsMs(b.updatedAt) - tsMs(a.updatedAt))[0].title
    }

    if (selectedTitle.value && !dirty.value) {
      const selectedMeta = notes.value.find((n) => n.title === selectedTitle.value)
      currentContent.value = noteContents.value[selectedTitle.value] || ''
      currentUpdatedAt.value = selectedMeta?.updatedAt || null
      dirty.value = Boolean(selectedMeta?.dirty)
    }
  }

  const initialize = async () => {
    const storedOps = await getPendingOps()
    pendingOps.value = storedOps.map(({ id: _id, ...op }) => op)

    await refreshStateFromCache()
    updateSyncStatus()
    if (online.value) {
      void syncWithServer().catch(() => undefined)
    }
    void connectWebSocket()
  }

  const selectNote = async (title: string) => {
    await flushPendingWrites()
    selectedTitle.value = title
    const cached = await getCachedNote(title)
    if (cached) {
      currentContent.value = cached.content || ''
      currentUpdatedAt.value = cached.updatedAt ? normalizeTs(cached.updatedAt) : null
      dirty.value = Boolean(cached.dirty)
    } else {
      currentContent.value = ''
      currentUpdatedAt.value = null
      dirty.value = false
    }

    if (!online.value) return

    try {
      const noteRes = await apiFetch(`/api/notes/${encodeURIComponent(title)}`)
      const serverNote = (await noteRes.json()) as NoteResponse
      const latestLocal = await getCachedNote(title)

      if (!latestLocal?.dirty) {
        await putCachedNote({
          title: serverNote.title,
          content: serverNote.content,
          updatedAt: normalizeTs(serverNote.updatedAt),
          dirty: false,
          starred: Boolean(serverNote.starred),
          existsOnServer: true
        })
      }

      if (selectedTitle.value === title && !dirty.value) {
        currentContent.value = serverNote.content || ''
        currentUpdatedAt.value = normalizeTs(serverNote.updatedAt)
        dirty.value = false
      }

      await refreshStateFromCache()
      clearSyncError()
    } catch (err: unknown) {
      if (!isNotFoundError(err)) {
        handleSyncFailure(err, t('couldNotFetchNote'))
      }
      void syncWithServer().catch(() => undefined)
    }
  }

  const applyLocalRename = async (oldTitle: string, desiredTitle: string) => {
    const local = await getCachedNote(oldTitle)
    if (!local) throw new Error(t('noNoteSelected'))

    const targetTitle = resolveUniqueTitle(new Set(notes.value.map((n) => n.title).filter((title) => title !== oldTitle)), desiredTitle)
    if (targetTitle === oldTitle) return targetTitle

    const renamed: CachedNote = {
      ...local,
      title: targetTitle,
      dirty: Boolean(local.dirty),
      existsOnServer: local.existsOnServer
    }

    await queueWrite(async () => {
      await putCachedNote(renamed)
      await deleteCachedNote(oldTitle)
    })

    if (selectedTitle.value === oldTitle) {
      selectedTitle.value = targetTitle
      currentContent.value = renamed.content || ''
      currentUpdatedAt.value = normalizeTs(renamed.updatedAt)
      dirty.value = Boolean(renamed.dirty)
    }

    await refreshStateFromCache()
    return targetTitle
  }

  const clearCurrentSelection = () => {
    selectedTitle.value = ''
    currentContent.value = ''
    currentUpdatedAt.value = null
    dirty.value = false
  }

  let resetWsFailuresAndReconnect: () => void = () => undefined

  const { mutatePendingOps, saveCurrent, syncWithServer } = createNotesSync({
    pendingOps,
    selectedTitle,
    currentContent,
    currentUpdatedAt,
    dirty,
    notes,
    online,
    syncing,
    getCachedNote,
    getAllCachedNotes,
    putCachedNote,
    deleteCachedNote,
    replacePendingOps,
    queueWrite,
    flushPendingWrites,
    refreshStateFromCache,
    isActiveNoteLocallyDirty,
    isServerBacked,
    samePendingOp,
    retargetPendingTitle,
    normalizeTs,
    newerTs,
    tsMs,
    apiFetch,
    isNotFoundError,
    resetWsFailuresAndReconnect: () => resetWsFailuresAndReconnect(),
    updateSyncStatus,
    clearSyncRetry,
    clearSyncError,
    handleSyncFailure
  })

  const wsController = createNotesWebSocket({
    online,
    wsConnected,
    clientOrigin,
    selectedTitle,
    currentContent,
    currentUpdatedAt,
    dirty,
    apiFetch,
    syncWithServer,
    refreshStateFromCache,
    getCachedNote,
    putCachedNote,
    deleteCachedNote,
    normalizeTs,
    isServerBacked,
    isActiveNoteLocallyDirty
  })
  const { connectWebSocket, disconnectWebSocket } = wsController
  resetWsFailuresAndReconnect = wsController.resetWsFailuresAndReconnect

  const generateDefaultTitle = (base = t('newNote')) => {
    const existing = new Set(notes.value.map((n) => n.title))
    if (!existing.has(base)) return base
    let i = 2
    while (existing.has(`${base} ${i}`)) i += 1
    return `${base} ${i}`
  }

  const createNote = async (title = '') => {
    const resolvedTitle = (title || generateDefaultTitle()).trim()
    if (!resolvedTitle) throw new Error(t('titleRequired'))

    await putCachedNote({
      title: resolvedTitle,
      content: '',
      updatedAt: new Date().toISOString(),
      dirty: true,
      existsOnServer: false
    })

    await refreshStateFromCache()
    await selectNote(resolvedTitle)

    if (!online.value) {
      updateSyncStatus()
      return resolvedTitle
    }

    void syncWithServer().catch(() => undefined)
    return resolvedTitle
  }

  const renameCurrent = async (newTitle: string) => {
    await flushPendingWrites()
    if (!selectedTitle.value) throw new Error(t('noNoteSelected'))
    const oldTitle = selectedTitle.value
    const requestedTitle = (newTitle || '').trim()

    if (!requestedTitle) throw new Error(t('titleRequired'))
    if (requestedTitle === oldTitle) return oldTitle

    const local = await getCachedNote(oldTitle)
    if (!local) throw new Error(t('noNoteSelected'))

    const targetTitle = resolveUniqueTitle(
      new Set(notes.value.map((n) => n.title).filter((title) => title !== oldTitle)),
      requestedTitle
    )

    const wasServerBacked = isServerBacked(local)
    const renamedTitle = await applyLocalRename(oldTitle, targetTitle)

    await mutatePendingOps((ops) => {
      const chainIdx = ops.findIndex((op) => op.type === 'rename' && op.newTitle === oldTitle)
      let next = retargetPendingTitle(ops, oldTitle, renamedTitle)

      if (wasServerBacked && chainIdx === -1) {
        next = [...next, { type: 'rename', oldTitle, newTitle: renamedTitle }]
      }

      return next
    })

    if (online.value) {
      void syncWithServer().catch(() => undefined)
    }

    return renamedTitle
  }

  const deleteCurrent = async () => {
    await flushPendingWrites()
    if (!selectedTitle.value) throw new Error(t('noNoteSelected'))
    const titleToDelete = selectedTitle.value
    const local = await getCachedNote(titleToDelete)
    const likelyServerBacked = isServerBacked(local)

    await queueWrite(async () => {
      await deleteCachedNote(titleToDelete)
    })

    clearCurrentSelection()
    await refreshStateFromCache()

    await mutatePendingOps((ops) => {
      let deleteTarget = titleToDelete
      let shouldDeleteOnServer = likelyServerBacked

      const next = ops.filter((op) => {
        if (op.type === 'star' && op.title === titleToDelete) return false
        return true
      })

      const renameToDeleted = next.find((op) => op.type === 'rename' && op.newTitle === titleToDelete)
      let pruned = next

      if (renameToDeleted && renameToDeleted.type === 'rename') {
        deleteTarget = renameToDeleted.oldTitle
        shouldDeleteOnServer = true
        pruned = pruned.filter(
          (op) => !(op.type === 'rename' && op.oldTitle === renameToDeleted.oldTitle && op.newTitle === renameToDeleted.newTitle)
        )
      }

      pruned = pruned.filter((op) => {
        if (op.type === 'star' && (op.title === deleteTarget || op.title === titleToDelete)) return false
        if (op.type === 'delete' && (op.title === titleToDelete || op.title === deleteTarget)) return false
        if (op.type === 'rename' && (op.oldTitle === titleToDelete || op.newTitle === titleToDelete)) return false
        return true
      })

      if (shouldDeleteOnServer) {
        pruned.push({ type: 'delete', title: deleteTarget })
      }

      return pruned
    })

    if (online.value) {
      void syncWithServer().catch(() => undefined)
    }
  }

  return {
    notes,
    sortedNotes,
    selectedTitle,
    currentContent,
    currentUpdatedAt,
    pinned,
    dirty,
    online,
    syncStatus,
    syncState,
    syncing,
    syncError,
    wsConnected,
    noteContents,
    setOnline,
    togglePin,
    initialize,
    selectNote,
    setCurrentContent,
    saveCurrent,
    syncWithServer,
    generateDefaultTitle,
    createNote,
    renameCurrent,
    deleteCurrent
  }
})

export type NotesStore = ReturnType<typeof useNotesStore>
