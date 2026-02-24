import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { deleteCachedNote, getAllCachedNotes, getCachedNote, getPendingOps, putCachedNote, replacePendingOps } from './notesDb'
import type { CachedNote, NoteMeta, NoteResponse, PendingOp, RenameResponse, SyncState } from '../types'
import { t } from '../i18n'
import {
  apiFetch,
  clientOrigin,
  isNetworkError,
  isNotFoundError,
  isServerBacked,
  newerTs,
  normalizeTs,
  resolveUniqueTitle,
  retargetPendingTitle,
  samePendingOp,
  toMeta,
  toUserSyncError,
  tsMs
} from './notesShared'

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
  const contentPersistDelayMs = 120
  let pendingContentSnapshot: CachedNote | null = null
  let contentPersistTimer: number | null = null
  let writeQueue: Promise<unknown> = Promise.resolve()
  let syncRetryTimer: number | null = null
  let syncRetryAttempt = 0
  let syncInFlight: Promise<void> | null = null
  let pushInFlight: Promise<void> | null = null
  let saveInFlight: Promise<void> | null = null
  const wsConnected = ref(false)
  let ws: WebSocket | null = null
  let wsReconnectTimer: number | null = null
  let wsReconnectAttempt = 0
  let wsConsecutiveFailures = 0
  let wsReconnectDisabled = false
  let lastMeUnauthorized = false
  let pendingRemoteChanges: Map<string, string> = new Map()
  let remoteChangeTimer: number | null = null

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

  const mutatePendingOps = async (mutator: (ops: PendingOp[]) => PendingOp[]) => {
    await queueWrite(async () => {
      const nextOps = mutator([...pendingOps.value])
      pendingOps.value = nextOps
      await replacePendingOps(nextOps)
    })
  }

  const removePendingOp = async (op: PendingOp) => {
    await mutatePendingOps((ops) => {
      const idx = ops.findIndex((candidate) => samePendingOp(candidate, op))
      if (idx === -1) return ops
      const next = [...ops]
      next.splice(idx, 1)
      return next
    })
  }

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
    wsConnected.value = false
    if (ws) {
      ws.close()
      ws = null
    }
    clearWsReconnect()
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

  const handleRemoteDelete = async (title: string) => {
    const local = await getCachedNote(title)
    const isCurrentDirty = isActiveNoteLocallyDirty(title)
    if (isCurrentDirty) return
    if (local && !isServerBacked(local)) return

    if (local && !local.dirty) {
      await deleteCachedNote(title)
    }
    if (selectedTitle.value === title) {
      selectedTitle.value = ''
      currentContent.value = ''
      currentUpdatedAt.value = null
      dirty.value = false
    }
    await refreshStateFromCache()
  }

  const handleRemoteNoteChange = async (title: string, action: string) => {
    if (action === 'deleted') {
      await handleRemoteDelete(title)
      return
    }

    if (isActiveNoteLocallyDirty(title)) return

    try {
      const noteRes = await apiFetch(`/api/notes/${encodeURIComponent(title)}`)
      const serverNote = (await noteRes.json()) as NoteResponse

      if (isActiveNoteLocallyDirty(title)) return

      const local = await getCachedNote(title)
      if (local?.dirty || isActiveNoteLocallyDirty(title)) return

      await putCachedNote({
        title: serverNote.title,
        content: serverNote.content,
        updatedAt: normalizeTs(serverNote.updatedAt),
        dirty: false,
        starred: Boolean(serverNote.starred),
        existsOnServer: true
      })
    } catch {
      // If note disappeared between event and fetch, reconcile via full sync.
      if (action === 'created' || action === 'updated') {
        void syncWithServer().catch(() => undefined)
      }
    }
  }

  const queueRemoteChange = (title: string, action: string) => {
    pendingRemoteChanges.set(title, action)
    if (remoteChangeTimer !== null) window.clearTimeout(remoteChangeTimer)
    remoteChangeTimer = window.setTimeout(() => {
      remoteChangeTimer = null
      const changes = Array.from(pendingRemoteChanges.entries())
      pendingRemoteChanges.clear()

      void (async () => {
        for (const [changedTitle, changedAction] of changes) {
          await handleRemoteNoteChange(changedTitle, changedAction)
        }
        await refreshStateFromCache()
      })().catch(() => {
        void syncWithServer().catch(() => undefined)
      })
    }, 200)
  }

  const clearWsReconnect = () => {
    if (wsReconnectTimer !== null) {
      window.clearTimeout(wsReconnectTimer)
      wsReconnectTimer = null
    }
  }

  const resetWsFailuresAndReconnect = () => {
    wsConsecutiveFailures = 0
    wsReconnectDisabled = false
    lastMeUnauthorized = false
    wsReconnectAttempt = 0
    clearWsReconnect()
    if (online.value && !wsConnected.value) {
      void connectWebSocket()
    }
  }

  const scheduleWsReconnect = () => {
    if (wsReconnectDisabled || wsReconnectTimer !== null) return
    const delay = Math.min(30000, 1000 * 2 ** wsReconnectAttempt)
    wsReconnectTimer = window.setTimeout(() => {
      wsReconnectTimer = null
      void connectWebSocket()
    }, delay)
    wsReconnectAttempt = Math.min(wsReconnectAttempt + 1, 5)
  }

  const connectWebSocket = async () => {
    if (!online.value || wsReconnectDisabled) return
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/api/ws`
    let opened = false

    try {
      ws = new WebSocket(wsUrl)
    } catch {
      wsConsecutiveFailures += 1
      if (wsConsecutiveFailures >= 5) {
        wsReconnectDisabled = true
        return
      }
      scheduleWsReconnect()
      return
    }

    ws.onopen = () => {
      opened = true
      wsConnected.value = true
      wsReconnectAttempt = 0
      wsConsecutiveFailures = 0
      wsReconnectDisabled = false
      lastMeUnauthorized = false
      clearWsReconnect()
      void syncWithServer().catch(() => undefined)
    }

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data)) as { type?: string; title?: string; action?: string; origin?: string }
        if (payload.type === 'note_changed' && payload.title && payload.action) {
          if (payload.origin && payload.origin === clientOrigin) return
          queueRemoteChange(payload.title, payload.action)
        }
      } catch {
        // ignore malformed payloads
      }
    }

    ws.onclose = (event) => {
      wsConnected.value = false
      ws = null

      if (!opened) {
        wsConsecutiveFailures += 1
      }

      if (event.code === 1008) {
        wsReconnectDisabled = true
        return
      }

      void (async () => {
        try {
          await apiFetch('/api/me')
          lastMeUnauthorized = false
        } catch (err: unknown) {
          lastMeUnauthorized = (err as Error)?.message === 'UNAUTHORIZED'
        }

        if (lastMeUnauthorized) {
          wsReconnectDisabled = true
          return
        }

        if (wsConsecutiveFailures >= 5) {
          wsReconnectDisabled = true
          return
        }

        scheduleWsReconnect()
      })()
    }

    ws.onerror = () => {
      wsConnected.value = false
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

  const queueWrite = (task: () => Promise<unknown>) => {
    writeQueue = writeQueue.then(task).catch(() => undefined)
    return writeQueue
  }

  const persistLatestContentSnapshot = async () => {
    const snapshot = pendingContentSnapshot
    if (!snapshot) return
    pendingContentSnapshot = null

    await queueWrite(async () => {
      const existing = await getCachedNote(snapshot.title)
      await putCachedNote({
        ...snapshot,
        existsOnServer: existing?.existsOnServer
      })
      if (selectedTitle.value === snapshot.title && contentVersion.value === snapshot.version) {
        updateSyncStatus()
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
    currentContent.value = content
    dirty.value = true
    const nowIso = new Date().toISOString()
    currentUpdatedAt.value = nowIso
    contentVersion.value += 1

    if (!selectedTitle.value) return

    const selectedMeta = notes.value.find((n) => n.title === selectedTitle.value)
    if (selectedMeta) {
      selectedMeta.dirty = true
      selectedMeta.updatedAt = nowIso
    }
    noteContents.value = {
      ...noteContents.value,
      [selectedTitle.value]: currentContent.value
    }

    pendingContentSnapshot = {
      title: selectedTitle.value,
      content: currentContent.value,
      updatedAt: nowIso,
      dirty: true,
      version: contentVersion.value,
      starred: selectedMeta?.starred
    }

    scheduleContentPersist()
  }

  const pushDirtyNote = async (title: string) => {
    const local = await getCachedNote(title)
    if (!local || !local.dirty) return

    let res: Response
    try {
      res = await apiFetch(`/api/notes/${encodeURIComponent(title)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: local.content })
      })
    } catch (err: unknown) {
      if (!isNotFoundError(err)) throw err

      // Note doesn't exist on server — create it instead of discarding
      res = await apiFetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, content: local.content })
      })
    }

    const saved = (await res.json()) as NoteResponse
    resetWsFailuresAndReconnect()

    // Dirty until server has saved the exact content we currently hold locally.
    const current = await getCachedNote(title)
    const activeMemoryDiffers = selectedTitle.value === title && currentContent.value !== saved.content
    const currentContentSnapshot = current?.content ?? local.content
    const stillDirty = activeMemoryDiffers || currentContentSnapshot !== saved.content
    const chosenContent = stillDirty
      ? (activeMemoryDiffers ? currentContent.value : currentContentSnapshot)
      : saved.content
    const chosenUpdatedAt = stillDirty
      ? normalizeTs(current?.updatedAt ?? local.updatedAt)
      : newerTs(current?.updatedAt ?? local.updatedAt, saved.updatedAt ?? local.updatedAt)

    await putCachedNote({
      title: saved.title,
      content: chosenContent,
      updatedAt: chosenUpdatedAt,
      dirty: stillDirty,
      starred: Boolean(saved.starred),
      existsOnServer: true
    })

    if (selectedTitle.value === title) {
      currentUpdatedAt.value = chosenUpdatedAt
      dirty.value = stillDirty

      const selectedMeta = notes.value.find((n) => n.title === title)
      if (selectedMeta) {
        selectedMeta.updatedAt = chosenUpdatedAt
        selectedMeta.dirty = stillDirty
      }
    }
  }

  const runPushDirtyNote = async (title: string) => {
    if (pushInFlight) await pushInFlight

    const task = pushDirtyNote(title)
    pushInFlight = task

    try {
      await task
    } finally {
      if (pushInFlight === task) pushInFlight = null
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

  const processPendingOps = async () => {
    while (pendingOps.value.length > 0) {
      const op = pendingOps.value[0]

      if (op.type === 'delete') {
        try {
          await apiFetch(`/api/notes/${encodeURIComponent(op.title)}`, { method: 'DELETE' })
        } catch (err: unknown) {
          if (!isNotFoundError(err)) throw err
        }
        resetWsFailuresAndReconnect()
        await removePendingOp(op)
        continue
      }

      if (op.type === 'star') {
        await apiFetch(`/api/notes/${encodeURIComponent(op.title)}/star`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ starred: op.starred })
        })
        resetWsFailuresAndReconnect()
        await removePendingOp(op)
        continue
      }

      let res: Response
      try {
        res = await apiFetch(`/api/notes/${encodeURIComponent(op.oldTitle)}/rename`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newTitle: op.newTitle })
        })
      } catch (err: unknown) {
        if (!isNotFoundError(err)) throw err

        const localMissingRename = await getCachedNote(op.newTitle)
        if (localMissingRename) {
          await queueWrite(async () => {
            await putCachedNote({ ...localMissingRename, existsOnServer: false })
          })
        }

        await removePendingOp(op)
        continue
      }
      resetWsFailuresAndReconnect()

      const payload = (await res.json()) as RenameResponse
      const serverTitle = payload?.title?.trim()
      if (!serverTitle) throw new Error(t('invalidServerTitle'))

      const renamedLocal = await getCachedNote(op.newTitle)
      if (renamedLocal) {
        if (serverTitle !== op.newTitle) {
          await queueWrite(async () => {
            await deleteCachedNote(op.newTitle)
            await putCachedNote({
              ...renamedLocal,
              title: serverTitle,
              existsOnServer: true,
              dirty: Boolean(renamedLocal.dirty)
            })
          })
          if (selectedTitle.value === op.newTitle) {
            selectedTitle.value = serverTitle
          }
        } else {
          await queueWrite(async () => {
            await putCachedNote({ ...renamedLocal, existsOnServer: true })
          })
        }
      }

      await mutatePendingOps((ops) => {
        const idx = ops.findIndex((candidate) => samePendingOp(candidate, op))
        if (idx === -1) return ops

        const next = [...ops]
        next.splice(idx, 1)

        if (serverTitle !== op.newTitle) {
          return retargetPendingTitle(next, op.newTitle, serverTitle)
        }

        return next
      })
    }
  }

  const saveCurrent = async () => {
    if (!selectedTitle.value) return
    if (saveInFlight) return saveInFlight

    const titleAtStart = selectedTitle.value

    saveInFlight = (async () => {
      await flushPendingWrites()
      const existing = await getCachedNote(titleAtStart)
      await putCachedNote({
        title: titleAtStart,
        content: currentContent.value,
        updatedAt: currentUpdatedAt.value || new Date().toISOString(),
        dirty: true,
        starred: existing?.starred,
        existsOnServer: existing?.existsOnServer
      })

      if (!online.value) {
        updateSyncStatus()
        return
      }

      syncing.value = true
      updateSyncStatus()
      try {
        await runPushDirtyNote(titleAtStart)
        clearSyncError()
      } catch (err: unknown) {
        handleSyncFailure(err, t('couldNotSaveNote'))
        throw err
      } finally {
        syncing.value = false
        updateSyncStatus()
      }
    })()

    try {
      await saveInFlight
    } finally {
      saveInFlight = null
    }
  }

  const syncWithServer = async () => {
    if (syncInFlight) return syncInFlight

    syncInFlight = (async () => {
      if (!online.value) {
        updateSyncStatus()
        return
      }

      await flushPendingWrites()
      syncing.value = true
      updateSyncStatus()

      try {
        await processPendingOps()

        const localNotes = await getAllCachedNotes()
        for (const local of localNotes) {
          if (!local.dirty) continue
          await runPushDirtyNote(local.title)
        }

        const metaRes = await apiFetch('/api/notes')
        const serverMetas = (await metaRes.json()) as NoteMeta[]
        const currentLocalMap = new Map((await getAllCachedNotes()).map((n) => [n.title, n]))
        const serverTitles = new Set(serverMetas.map((n) => n.title))

        for (const local of currentLocalMap.values()) {
          if (local.dirty || !isServerBacked(local) || serverTitles.has(local.title)) continue

          await deleteCachedNote(local.title)

          if (selectedTitle.value === local.title) {
            selectedTitle.value = ''
            currentContent.value = ''
            currentUpdatedAt.value = null
            dirty.value = false
          }
        }

        for (const serverMeta of serverMetas) {
          const local = currentLocalMap.get(serverMeta.title)
          const serverTs = tsMs(serverMeta.updatedAt)
          const localTs = local ? tsMs(local.updatedAt) : 0
          const isActiveAndDirty = isActiveNoteLocallyDirty(serverMeta.title)
          const shouldPull = !isActiveAndDirty && (!local || (!local.dirty && serverTs > localTs))

          if (local && local.starred !== serverMeta.starred) {
            await putCachedNote({ ...local, starred: Boolean(serverMeta.starred), existsOnServer: true })
          }

          if (!shouldPull) continue

          let noteRes: Response
          try {
            noteRes = await apiFetch(`/api/notes/${encodeURIComponent(serverMeta.title)}`)
          } catch {
            continue
          }
          const serverNote = (await noteRes.json()) as NoteResponse
          await putCachedNote({
            title: serverNote.title,
            content: serverNote.content,
            updatedAt: normalizeTs(serverNote.updatedAt || serverMeta.updatedAt),
            dirty: false,
            starred: Boolean(serverNote.starred ?? serverMeta.starred),
            existsOnServer: true
          })
        }

        await refreshStateFromCache()
        clearSyncRetry()
        clearSyncError()
      } catch (err: unknown) {
        handleSyncFailure(err, t('couldNotSync'))
        throw err
      } finally {
        syncing.value = false
        updateSyncStatus()
      }
    })()

    try {
      await syncInFlight
    } finally {
      syncInFlight = null
    }
  }

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
