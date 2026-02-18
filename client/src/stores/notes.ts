import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { deleteCachedNote, getAllCachedNotes, getCachedNote, putCachedNote } from './notesDb'
import type { CachedNote, NoteMeta, NoteResponse, RenameResponse } from '../types'


function normalizeTs(value?: string | null): string {
  if (!value) return ''
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) return ''
  return new Date(ms).toISOString()
}

function toMeta(note: CachedNote): NoteMeta {
  return {
    title: note.title,
    updatedAt: normalizeTs(note.updatedAt),
    dirty: Boolean(note.dirty),
    starred: Boolean(note.starred)
  }
}

function tsMs(value?: string | null): number {
  if (!value) return 0
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? 0 : ms
}

function newerTs(a?: string | null, b?: string | null): string {
  return tsMs(a) >= tsMs(b) ? normalizeTs(a) : normalizeTs(b)
}

function isNetworkError(err: unknown): boolean {
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

function toUserSyncError(err: unknown, fallback: string): string {
  if ((err as Error)?.message === 'UNAUTHORIZED') return 'UNAUTHORIZED'
  if (isNetworkError(err)) return 'Midlertidig forbindelsesproblem'
  return (err as Error)?.message || fallback
}

class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404
}

async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init)

  if (res.status === 401) {
    throw new Error('UNAUTHORIZED')
  }

  if (!res.ok) {
    let message = 'Request failed'
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

export const useNotesStore = defineStore('notes', () => {
  const notes = ref<NoteMeta[]>([])
  const selectedTitle = ref('')
  const currentContent = ref('')
  const currentUpdatedAt = ref<string | null>(null)
  const pinned = computed(() => new Set(notes.value.filter((n) => n.starred).map((n) => n.title)))
  const dirty = ref(false)
  const online = ref(navigator.onLine)
  const syncStatus = ref('Synkroniseret')
  const syncing = ref(false)
  const syncError = ref('')
  const contentVersion = ref(0)
  const noteContents = ref<Record<string, string>>({})
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

  const updateSyncStatus = () => {
    if (!online.value) {
      syncStatus.value = 'Offline — ændringer gemmes lokalt'
    } else if (syncing.value) {
      syncStatus.value = 'Synkroniserer...'
    } else if (syncError.value) {
      syncStatus.value = `Sync-fejl: ${syncError.value}`
    } else {
      syncStatus.value = 'Synkroniseret'
    }
  }

  const setSyncError = (message: string) => {
    syncError.value = message || 'Ukendt fejl'
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
    await apiFetch(`/api/notes/${encodeURIComponent(title)}/star`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ starred: nextStarred })
    })
    resetWsFailuresAndReconnect()

    note.starred = nextStarred

    const cached = await getCachedNote(title)
    if (cached) {
      await putCachedNote({ ...cached, starred: nextStarred })
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
    const isCurrentDirty = selectedTitle.value === title && dirty.value
    if (isCurrentDirty) return

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

    const isCurrentDirty = selectedTitle.value === title && dirty.value
    if (isCurrentDirty) return

    try {
      const noteRes = await apiFetch(`/api/notes/${encodeURIComponent(title)}`)
      const serverNote = (await noteRes.json()) as NoteResponse

      const local = await getCachedNote(title)
      if (local?.dirty) return

      await putCachedNote({
        title: serverNote.title,
        content: serverNote.content,
        updatedAt: normalizeTs(serverNote.updatedAt),
        dirty: false,
        starred: Boolean(serverNote.starred)
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
        const payload = JSON.parse(String(event.data)) as { type?: string; title?: string; action?: string }
        if (payload.type === 'note_changed' && payload.title && payload.action) {
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
    await refreshStateFromCache()
    updateSyncStatus()
    if (online.value) {
      void syncWithServer().catch(() => undefined)
    }
    void connectWebSocket()
  }

  const selectNote = async (title: string) => {
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
          starred: Boolean(serverNote.starred)
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
        handleSyncFailure(err, 'Kunne ikke hente note')
      }
      void syncWithServer().catch(() => undefined)
    }
  }

  const queueWrite = (task: () => Promise<unknown>) => {
    writeQueue = writeQueue.then(task).catch(() => undefined)
    return writeQueue
  }

  const flushPendingWrites = async () => {
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

    const snapshot: CachedNote = {
      title: selectedTitle.value,
      content: currentContent.value,
      updatedAt: nowIso,
      dirty: true,
      version: contentVersion.value,
      starred: selectedMeta?.starred
    }

    await queueWrite(async () => {
      await putCachedNote(snapshot)
      if (selectedTitle.value === snapshot.title && contentVersion.value === snapshot.version) {
        updateSyncStatus()
      }
    })
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
    const stillDirty = Boolean(current?.dirty) && (current?.content ?? '') !== saved.content
    const chosenContent = stillDirty ? (current?.content ?? local.content) : saved.content
    const chosenUpdatedAt = stillDirty
      ? normalizeTs(current?.updatedAt ?? local.updatedAt)
      : newerTs(current?.updatedAt ?? local.updatedAt, saved.updatedAt ?? local.updatedAt)

    await putCachedNote({
      title: saved.title,
      content: chosenContent,
      updatedAt: chosenUpdatedAt,
      dirty: stillDirty,
      starred: Boolean(saved.starred)
    })

    if (selectedTitle.value === title && !stillDirty) {
      currentUpdatedAt.value = chosenUpdatedAt
      dirty.value = false

      const selectedMeta = notes.value.find((n) => n.title === title)
      if (selectedMeta) {
        selectedMeta.updatedAt = chosenUpdatedAt
        selectedMeta.dirty = false
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

  const saveCurrent = async () => {
    if (!selectedTitle.value) return
    if (saveInFlight) return saveInFlight

    const titleAtStart = selectedTitle.value

    saveInFlight = (async () => {
      await flushPendingWrites()
      await putCachedNote({
        title: titleAtStart,
        content: currentContent.value,
        updatedAt: currentUpdatedAt.value || new Date().toISOString(),
        dirty: true
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
        handleSyncFailure(err, 'Kunne ikke gemme note')
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
          if (local.dirty || serverTitles.has(local.title)) continue

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
          const isActiveAndDirty = serverMeta.title === selectedTitle.value && dirty.value
          const shouldPull = !isActiveAndDirty && (!local || (!local.dirty && serverTs > localTs))

          if (local && local.starred !== serverMeta.starred) {
            await putCachedNote({ ...local, starred: Boolean(serverMeta.starred) })
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
            starred: Boolean(serverNote.starred ?? serverMeta.starred)
          })
        }

        await refreshStateFromCache()
        clearSyncRetry()
        clearSyncError()
      } catch (err: unknown) {
        handleSyncFailure(err, 'Kunne ikke synkronisere')
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

  const generateDefaultTitle = (base = 'Ny note') => {
    const existing = new Set(notes.value.map((n) => n.title))
    if (!existing.has(base)) return base
    let i = 2
    while (existing.has(`${base} ${i}`)) i += 1
    return `${base} ${i}`
  }

  const createNote = async (title = '') => {
    const resolvedTitle = (title || generateDefaultTitle()).trim()
    if (!resolvedTitle) throw new Error('Titel er påkrævet')

    await putCachedNote({
      title: resolvedTitle,
      content: '',
      updatedAt: new Date().toISOString(),
      dirty: true
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
    if (!selectedTitle.value) throw new Error('Ingen note valgt')
    const oldTitle = selectedTitle.value
    const requestedTitle = (newTitle || '').trim()

    if (!requestedTitle) throw new Error('Titel er påkrævet')
    if (requestedTitle === oldTitle) return oldTitle
    if (!online.value) throw new Error('Du skal være online for at omdøbe noter')

    if (dirty.value) await saveCurrent()

    const res = await apiFetch(`/api/notes/${encodeURIComponent(oldTitle)}/rename`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newTitle: requestedTitle })
    })

    const payload = (await res.json()) as RenameResponse
    resetWsFailuresAndReconnect()

    const serverTitle = payload?.title?.trim()
    if (!serverTitle) throw new Error('Server returnerede ugyldig titel')

    const contentToPersist = payload?.content ?? currentContent.value
    const updatedAt = normalizeTs(payload?.updatedAt || currentUpdatedAt.value || new Date().toISOString())

    await deleteCachedNote(oldTitle)
    await putCachedNote({ title: serverTitle, content: contentToPersist, updatedAt, dirty: false })

    selectedTitle.value = serverTitle
    currentContent.value = contentToPersist
    currentUpdatedAt.value = updatedAt
    dirty.value = false

    await refreshStateFromCache()
    return serverTitle
  }

  const deleteCurrent = async () => {
    if (!selectedTitle.value) throw new Error('Ingen note valgt')
    const titleToDelete = selectedTitle.value

    if (!online.value) throw new Error('Du skal være online for at slette noter')
    if (dirty.value) await saveCurrent()

    try {
      await apiFetch(`/api/notes/${encodeURIComponent(titleToDelete)}`, {
        method: 'DELETE'
      })
      resetWsFailuresAndReconnect()
    } catch (err: unknown) {
      if (!isNotFoundError(err)) throw err
    }

    await deleteCachedNote(titleToDelete)

    selectedTitle.value = ''
    currentContent.value = ''
    currentUpdatedAt.value = null
    dirty.value = false

    await refreshStateFromCache()
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
