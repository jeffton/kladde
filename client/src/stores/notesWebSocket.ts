import type { Ref } from 'vue'
import type { CachedNote, NoteResponse } from '../types'

interface NotesWebSocketDeps {
  online: Ref<boolean>
  wsConnected: Ref<boolean>
  clientOrigin: string
  selectedTitle: Ref<string>
  currentContent: Ref<string>
  currentUpdatedAt: Ref<string | null>
  dirty: Ref<boolean>
  apiFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  syncWithServer: () => Promise<void>
  refreshStateFromCache: () => Promise<void>
  getCachedNote: (title: string) => Promise<CachedNote | undefined>
  putCachedNote: (note: CachedNote) => Promise<IDBValidKey>
  deleteCachedNote: (title: string) => Promise<void>
  normalizeTs: (value?: string | null) => string
  isServerBacked: (note?: CachedNote | null) => boolean
  isActiveNoteLocallyDirty: (title: string) => boolean
}

export function createNotesWebSocket(deps: NotesWebSocketDeps) {
  let ws: WebSocket | null = null
  let wsReconnectTimer: number | null = null
  let wsReconnectAttempt = 0
  let wsConsecutiveFailures = 0
  let wsReconnectDisabled = false
  let lastMeUnauthorized = false
  let pendingRemoteChanges: Map<string, string> = new Map()
  let remoteChangeTimer: number | null = null

  const clearWsReconnect = () => {
    if (wsReconnectTimer !== null) {
      window.clearTimeout(wsReconnectTimer)
      wsReconnectTimer = null
    }
  }

  const handleRemoteDelete = async (title: string) => {
    const local = await deps.getCachedNote(title)
    const isCurrentDirty = deps.isActiveNoteLocallyDirty(title)
    if (isCurrentDirty) return
    if (local && !deps.isServerBacked(local)) return

    if (local && !local.dirty) {
      await deps.deleteCachedNote(title)
    }
    if (deps.selectedTitle.value === title) {
      deps.selectedTitle.value = ''
      deps.currentContent.value = ''
      deps.currentUpdatedAt.value = null
      deps.dirty.value = false
    }
    await deps.refreshStateFromCache()
  }

  const handleRemoteNoteChange = async (title: string, action: string) => {
    if (action === 'deleted') {
      await handleRemoteDelete(title)
      return
    }

    if (deps.isActiveNoteLocallyDirty(title)) return

    try {
      const noteRes = await deps.apiFetch(`/api/notes/${encodeURIComponent(title)}`)
      const serverNote = (await noteRes.json()) as NoteResponse

      if (deps.isActiveNoteLocallyDirty(title)) return

      const local = await deps.getCachedNote(title)
      if (local?.dirty || deps.isActiveNoteLocallyDirty(title)) return

      await deps.putCachedNote({
        title: serverNote.title,
        content: serverNote.content,
        updatedAt: deps.normalizeTs(serverNote.updatedAt),
        dirty: false,
        starred: Boolean(serverNote.starred),
        existsOnServer: true
      })
    } catch {
      // If note disappeared between event and fetch, reconcile via full sync.
      if (action === 'created' || action === 'updated') {
        void deps.syncWithServer().catch(() => undefined)
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
        await deps.refreshStateFromCache()
      })().catch(() => {
        void deps.syncWithServer().catch(() => undefined)
      })
    }, 200)
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
    if (!deps.online.value || wsReconnectDisabled) return
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
      deps.wsConnected.value = true
      wsReconnectAttempt = 0
      wsConsecutiveFailures = 0
      wsReconnectDisabled = false
      lastMeUnauthorized = false
      clearWsReconnect()
      void deps.syncWithServer().catch(() => undefined)
    }

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data)) as { type?: string; title?: string; action?: string; origin?: string }
        if (payload.type === 'note_changed' && payload.title && payload.action) {
          if (payload.origin && payload.origin === deps.clientOrigin) return
          queueRemoteChange(payload.title, payload.action)
        }
      } catch {
        // ignore malformed payloads
      }
    }

    ws.onclose = (event) => {
      deps.wsConnected.value = false
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
          await deps.apiFetch('/api/me')
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
      deps.wsConnected.value = false
    }
  }

  const resetWsFailuresAndReconnect = () => {
    wsConsecutiveFailures = 0
    wsReconnectDisabled = false
    lastMeUnauthorized = false
    wsReconnectAttempt = 0
    clearWsReconnect()
    if (deps.online.value && !deps.wsConnected.value) {
      void connectWebSocket()
    }
  }

  const disconnectWebSocket = () => {
    deps.wsConnected.value = false
    if (ws) {
      ws.close()
      ws = null
    }
    clearWsReconnect()
  }

  return {
    connectWebSocket,
    resetWsFailuresAndReconnect,
    disconnectWebSocket
  }
}
