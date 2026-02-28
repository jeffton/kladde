import { computed, onUnmounted, reactive, ref, type ComputedRef } from 'vue'
import { ApiError, apiFetch, clientOrigin, sharedNotePathApi } from '../stores/notesApi'
import { isUnauthorizedError } from '../stores/notesErrors'
import { t } from '../i18n'
import type { AppMode, EditorStoreLike, NoteMeta, SharedNoteResponse, ShareMode, SyncState } from '../types'

interface UseShareSessionOptions {
  isShareRoute: ComputedRef<boolean>
  shareToken: ComputedRef<string>
}

export function useShareSession({ isShareRoute, shareToken }: UseShareSessionOptions) {
  const shareMode = ref<ShareMode>('view')
  const shareError = ref('')
  const shareLoading = ref(false)
  const shareDirty = ref(false)
  const shareSaving = ref(false)
  const sharePendingRefresh = ref(false)

  const shareStore = reactive<EditorStoreLike>({
    notes: [],
    selectedKey: '',
    selectedTitle: '',
    selectedCollection: '',
    currentContent: '',
    currentUpdatedAt: null,
    syncStatus: t('loading'),
    syncState: 'syncing',
    collections: [],
    noteContents: {},
    setCurrentContent: async () => undefined,
    renameCurrent: async () => '',
    moveCurrentToCollection: async () => '',
    deleteCurrent: async () => undefined
  })

  const shareAppMode = computed<AppMode>(() => (shareMode.value === 'edit' ? 'share-edit' : 'share-readonly'))

  let shareSaveTimer: number | null = null
  let shareWs: WebSocket | null = null
  let shareReconnectTimer: number | null = null
  let shareReconnectAttempt = 0
  let shareDestroyed = false
  let shareReconnectHalted = false

  function toShareMessage(err: unknown): string {
    const message = (err as Error)?.message || ''
    if (!message || isUnauthorizedError(err)) return t('genericError')
    return message
  }

  function isFatalShareError(err: unknown): boolean {
    if (isUnauthorizedError(err)) return true
    if (err instanceof ApiError) {
      return err.status === 401 || err.status === 403 || err.status === 404
    }
    return false
  }

  function setShareSync(state: SyncState, status: string) {
    shareStore.syncState = state
    shareStore.syncStatus = status
  }

  function clearShareSaveTimer() {
    if (shareSaveTimer !== null) {
      window.clearTimeout(shareSaveTimer)
      shareSaveTimer = null
    }
  }

  function clearShareReconnectTimer() {
    if (shareReconnectTimer !== null) {
      window.clearTimeout(shareReconnectTimer)
      shareReconnectTimer = null
    }
  }

  function closeShareSocket() {
    shareWs?.close()
    shareWs = null
  }

  function resetShareStoreState() {
    shareMode.value = 'view'
    shareError.value = ''
    shareLoading.value = true
    shareDirty.value = false
    shareSaving.value = false
    sharePendingRefresh.value = false
    shareReconnectHalted = false
    shareStore.notes = []
    shareStore.selectedKey = ''
    shareStore.selectedTitle = ''
    shareStore.selectedCollection = ''
    shareStore.currentContent = ''
    shareStore.currentUpdatedAt = null
    shareStore.noteContents = {}
    setShareSync('syncing', t('loading'))
  }

  function applySharedNote(note: SharedNoteResponse) {
    shareMode.value = note.shareMode === 'edit' ? 'edit' : 'view'

    const key = note.key.trim()
    const title = note.title.trim()
    const collection = (note.collection || '').trim()
    const content = note.content
    const updatedAt = note.updatedAt

    const meta: NoteMeta = {
      key,
      title,
      collection,
      updatedAt,
      dirty: false,
      starred: Boolean(note.starred)
    }

    shareStore.selectedKey = key
    shareStore.selectedTitle = title
    shareStore.selectedCollection = collection
    shareStore.currentContent = content
    shareStore.currentUpdatedAt = updatedAt
    shareStore.noteContents = { [key]: content }
    shareStore.notes = [meta]

    shareDirty.value = false
    sharePendingRefresh.value = false
    shareError.value = ''
    shareReconnectHalted = false

    setShareSync('synced', shareMode.value === 'view' ? t('shareReadonly') : t('syncedShort'))
  }

  async function fetchSharedNote(force = false): Promise<boolean> {
    if (!shareToken.value) {
      shareLoading.value = false
      shareError.value = t('genericError')
      shareReconnectHalted = true
      setShareSync('error', shareError.value)
      return false
    }

    if (shareDirty.value && !force) {
      sharePendingRefresh.value = true
      return true
    }

    try {
      const response = await apiFetch(sharedNotePathApi(shareToken.value))
      const note = (await response.json()) as SharedNoteResponse
      applySharedNote(note)
      return true
    } catch (err) {
      shareError.value = toShareMessage(err)
      setShareSync('error', shareError.value)
      if (isFatalShareError(err)) {
        shareReconnectHalted = true
      }
      return false
    } finally {
      shareLoading.value = false
    }
  }

  async function refreshSharedNoteForReconnect(): Promise<boolean> {
    if (!shareToken.value) {
      shareError.value = t('genericError')
      shareReconnectHalted = true
      setShareSync('error', shareError.value)
      return false
    }

    try {
      const response = await apiFetch(sharedNotePathApi(shareToken.value))
      const note = (await response.json()) as SharedNoteResponse

      if (shareDirty.value || shareSaving.value) {
        sharePendingRefresh.value = true
        return true
      }

      applySharedNote(note)
      return true
    } catch (err) {
      shareError.value = toShareMessage(err)
      setShareSync('error', shareError.value)
      if (isFatalShareError(err)) {
        shareReconnectHalted = true
      }
      return false
    }
  }

  async function saveSharedNote() {
    if (!shareToken.value || shareMode.value !== 'edit' || !shareDirty.value || shareSaving.value) return

    shareSaving.value = true
    setShareSync('syncing', t('syncingShort'))

    try {
      const response = await apiFetch(sharedNotePathApi(shareToken.value), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: shareStore.currentContent })
      })

      const note = (await response.json()) as SharedNoteResponse
      applySharedNote(note)

      if (sharePendingRefresh.value) {
        await fetchSharedNote(true)
      }
    } catch (err) {
      shareError.value = toShareMessage(err)
      setShareSync('error', shareError.value)
      if (isFatalShareError(err)) {
        shareReconnectHalted = true
      }
    } finally {
      shareSaving.value = false
    }
  }

  function scheduleShareSave() {
    if (shareMode.value !== 'edit') return

    clearShareSaveTimer()
    shareSaveTimer = window.setTimeout(() => {
      shareSaveTimer = null
      void saveSharedNote()
    }, 450)
  }

  function scheduleShareReconnect() {
    if (shareDestroyed || shareReconnectTimer !== null || !isShareRoute.value || shareReconnectHalted) return

    const delay = Math.min(30000, 1000 * 2 ** shareReconnectAttempt)
    shareReconnectTimer = window.setTimeout(() => {
      shareReconnectTimer = null
      void attemptShareReconnect()
    }, delay)

    shareReconnectAttempt = Math.min(shareReconnectAttempt + 1, 5)
  }

  async function attemptShareReconnect() {
    if (shareDestroyed || !isShareRoute.value || shareReconnectHalted) return

    const refreshed = await refreshSharedNoteForReconnect()
    if (!refreshed) {
      if (!shareReconnectHalted) {
        scheduleShareReconnect()
      }
      return
    }

    connectShareSocket()
  }

  function connectShareSocket() {
    if (!shareToken.value || shareDestroyed || !isShareRoute.value || shareReconnectHalted) return
    if (shareWs && (shareWs.readyState === WebSocket.OPEN || shareWs.readyState === WebSocket.CONNECTING)) return

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/client-api/ws?shareToken=${encodeURIComponent(shareToken.value)}`

    try {
      shareWs = new WebSocket(wsUrl)
    } catch {
      scheduleShareReconnect()
      return
    }

    shareWs.onopen = () => {
      shareReconnectAttempt = 0
      clearShareReconnectTimer()
    }

    shareWs.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data)) as {
          type?: string
          origin?: string
        }

        if (payload.type !== 'note_changed') return
        if (payload.origin && payload.origin === clientOrigin) return

        if (shareDirty.value || shareSaving.value) {
          sharePendingRefresh.value = true
          return
        }

        void fetchSharedNote()
      } catch {
        // Ignore malformed payloads.
      }
    }

    shareWs.onclose = () => {
      shareWs = null
      if (!shareDestroyed && isShareRoute.value) {
        scheduleShareReconnect()
      }
    }

    shareWs.onerror = () => {
      shareWs?.close()
    }
  }

  function teardownShareSession() {
    clearShareSaveTimer()
    clearShareReconnectTimer()
    closeShareSocket()
    shareReconnectAttempt = 0
  }

  async function initializeShareSession() {
    teardownShareSession()
    resetShareStoreState()

    if (!shareToken.value) {
      shareLoading.value = false
      shareError.value = t('genericError')
      shareReconnectHalted = true
      setShareSync('error', shareError.value)
      return
    }

    const loaded = await fetchSharedNote(true)
    if (!loaded) {
      return
    }

    connectShareSocket()
  }

  shareStore.setCurrentContent = async (content: string) => {
    if (shareMode.value !== 'edit') return
    if (content === shareStore.currentContent) return

    shareStore.currentContent = content

    if (shareStore.selectedKey) {
      shareStore.noteContents = {
        ...shareStore.noteContents,
        [shareStore.selectedKey]: content
      }
    }

    if (shareStore.notes.length > 0) {
      const current = shareStore.notes[0]
      const updatedAt = new Date().toISOString()
      shareStore.notes = [
        {
          ...current,
          updatedAt,
          dirty: true
        }
      ]
      shareStore.currentUpdatedAt = updatedAt
    }

    shareDirty.value = true
    setShareSync('syncing', t('syncingShort'))
    scheduleShareSave()
  }

  shareStore.renameCurrent = async () => shareStore.selectedKey
  shareStore.moveCurrentToCollection = async () => shareStore.selectedKey
  shareStore.deleteCurrent = async () => undefined

  function clearShareError() {
    shareError.value = ''
  }

  function setShareUiErrorMessage(message: string) {
    shareError.value = message || t('genericError')
    setShareSync('error', shareError.value)
  }

  onUnmounted(() => {
    shareDestroyed = true
    teardownShareSession()
  })

  return {
    shareAppMode,
    shareError,
    shareLoading,
    shareStore,
    clearShareError,
    setShareUiErrorMessage,
    initializeShareSession,
    teardownShareSession
  }
}
