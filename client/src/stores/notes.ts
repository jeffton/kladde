import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { deleteCachedNote, getAllCachedNotes, getCachedNote, putCachedNote } from './notesDb'
import type { CachedNote, NoteMeta, NoteResponse, RenameResponse } from '../types'

const PINNED_KEY = 'noteapp:pinned'

function loadPinned(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(PINNED_KEY) ?? '[]') as string[])
  } catch {
    return new Set<string>()
  }
}

function normalizeTs(value?: string | null): string {
  return value ? new Date(value).toISOString() : new Date().toISOString()
}

function toMeta(note: CachedNote): NoteMeta {
  return {
    title: note.title,
    updatedAt: normalizeTs(note.updatedAt),
    dirty: Boolean(note.dirty)
  }
}

export const useNotesStore = defineStore('notes', () => {
  const notes = ref<NoteMeta[]>([])
  const selectedTitle = ref('')
  const currentContent = ref('')
  const currentUpdatedAt = ref<string | null>(null)
  const pinned = ref(loadPinned())
  const dirty = ref(false)
  const online = ref(navigator.onLine)
  const syncStatus = ref('Synkroniseret')
  const syncing = ref(false)
  const syncError = ref('')
  const contentVersion = ref(0)
  const noteContents = ref<Record<string, string>>({})
  let writeQueue: Promise<unknown> = Promise.resolve()

  const sortedNotes = computed(() => {
    return [...notes.value].sort((a, b) => {
      const aPinned = pinned.value.has(a.title)
      const bPinned = pinned.value.has(b.title)
      if (aPinned !== bPinned) return aPinned ? -1 : 1
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
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

  const clearSyncError = () => {
    syncError.value = ''
    updateSyncStatus()
  }

  const setOnline = (value: boolean) => {
    online.value = value
    updateSyncStatus()
    if (value) {
      void syncWithServer().catch((err: unknown) => setSyncError((err as Error)?.message || 'Kunne ikke synkronisere'))
    }
  }

  const togglePin = (title: string) => {
    if (pinned.value.has(title)) pinned.value.delete(title)
    else pinned.value.add(title)
    localStorage.setItem(PINNED_KEY, JSON.stringify([...pinned.value]))
  }

  const refreshStateFromCache = async () => {
    const cached = await getAllCachedNotes()
    notes.value = cached.map(toMeta)
    noteContents.value = Object.fromEntries(cached.map((n) => [n.title, n.content || '']))

    if (!selectedTitle.value && cached.length > 0) {
      selectedTitle.value = cached.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0].title
    }

    if (selectedTitle.value) {
      const selected = cached.find((n) => n.title === selectedTitle.value)
      if (selected) {
        currentContent.value = selected.content || ''
        currentUpdatedAt.value = normalizeTs(selected.updatedAt)
        dirty.value = Boolean(selected.dirty)
      }
    }
  }

  const initialize = async () => {
    await refreshStateFromCache()
    updateSyncStatus()
    if (online.value) {
      void syncWithServer().catch((err: unknown) => setSyncError((err as Error)?.message || 'Kunne ikke synkronisere'))
    }
  }

  const selectNote = async (title: string) => {
    selectedTitle.value = title
    const cached = await getCachedNote(title)
    if (cached) {
      currentContent.value = cached.content || ''
      currentUpdatedAt.value = normalizeTs(cached.updatedAt)
      dirty.value = Boolean(cached.dirty)
      return
    }

    currentContent.value = ''
    currentUpdatedAt.value = null
    dirty.value = false

    if (online.value) {
      void syncWithServer().catch((err: unknown) => setSyncError((err as Error)?.message || 'Kunne ikke synkronisere'))
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
    currentUpdatedAt.value = new Date().toISOString()
    contentVersion.value += 1

    if (!selectedTitle.value) return

    const snapshot: CachedNote = {
      title: selectedTitle.value,
      content: currentContent.value,
      updatedAt: currentUpdatedAt.value,
      dirty: true,
      version: contentVersion.value
    }

    await queueWrite(async () => {
      await putCachedNote(snapshot)
      if (selectedTitle.value === snapshot.title && contentVersion.value === snapshot.version) {
        await refreshStateFromCache()
        updateSyncStatus()
      }
    })
  }

  const pushDirtyNote = async (title: string) => {
    const local = await getCachedNote(title)
    if (!local || !local.dirty) return

    const res = await fetch(`/api/notes/${encodeURIComponent(title)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: local.content })
    })
    if (!res.ok) throw new Error('Save failed')

    const saved = (await res.json()) as NoteResponse
    await putCachedNote({
      title: saved.title,
      content: saved.content,
      updatedAt: normalizeTs(saved.updatedAt),
      dirty: false
    })

    if (selectedTitle.value === title) {
      currentUpdatedAt.value = normalizeTs(saved.updatedAt)
      dirty.value = false
    }
  }

  const saveCurrent = async () => {
    if (!selectedTitle.value) return

    await flushPendingWrites()
    await putCachedNote({
      title: selectedTitle.value,
      content: currentContent.value,
      updatedAt: currentUpdatedAt.value || new Date().toISOString(),
      dirty: true
    })
    await refreshStateFromCache()

    if (!online.value) {
      updateSyncStatus()
      return
    }

    syncing.value = true
    updateSyncStatus()
    try {
      await pushDirtyNote(selectedTitle.value)
      await refreshStateFromCache()
      clearSyncError()
    } catch (err: unknown) {
      setSyncError((err as Error)?.message || 'Kunne ikke gemme note')
      throw err
    } finally {
      syncing.value = false
      updateSyncStatus()
    }
  }

  const syncWithServer = async () => {
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
        await pushDirtyNote(local.title)
      }

      const metaRes = await fetch('/api/notes')
      if (!metaRes.ok) throw new Error('Kunne ikke hente noter')
      const serverMetas = (await metaRes.json()) as NoteMeta[]
      const currentLocalMap = new Map((await getAllCachedNotes()).map((n) => [n.title, n]))

      for (const serverMeta of serverMetas) {
        const local = currentLocalMap.get(serverMeta.title)
        const serverTs = new Date(serverMeta.updatedAt).getTime()
        const localTs = local ? new Date(local.updatedAt).getTime() : 0
        const shouldPull = !local || (!local.dirty && serverTs > localTs)
        if (!shouldPull) continue

        const noteRes = await fetch(`/api/notes/${encodeURIComponent(serverMeta.title)}`)
        if (!noteRes.ok) continue
        const serverNote = (await noteRes.json()) as NoteResponse
        await putCachedNote({
          title: serverNote.title,
          content: serverNote.content,
          updatedAt: normalizeTs(serverNote.updatedAt),
          dirty: false
        })
      }

      await refreshStateFromCache()
      clearSyncError()
    } catch (err: unknown) {
      setSyncError((err as Error)?.message || 'Kunne ikke synkronisere')
      throw err
    } finally {
      syncing.value = false
      updateSyncStatus()
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

    void syncWithServer().catch((err: unknown) => setSyncError((err as Error)?.message || 'Kunne ikke synkronisere'))
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

    const res = await fetch(`/api/notes/${encodeURIComponent(oldTitle)}/rename`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newTitle: requestedTitle })
    })

    let payload: RenameResponse | null = null
    try {
      payload = (await res.json()) as RenameResponse
    } catch {
      payload = null
    }

    if (!res.ok) throw new Error(payload?.error || 'Kunne ikke omdøbe note')

    const serverTitle = payload?.title?.trim()
    if (!serverTitle) throw new Error('Server returnerede ugyldig titel')

    const contentToPersist = payload?.content ?? currentContent.value
    const updatedAt = normalizeTs(payload?.updatedAt)

    await deleteCachedNote(oldTitle)
    await putCachedNote({ title: serverTitle, content: contentToPersist, updatedAt, dirty: false })

    if (pinned.value.has(oldTitle)) {
      pinned.value.delete(oldTitle)
      pinned.value.add(serverTitle)
      localStorage.setItem(PINNED_KEY, JSON.stringify([...pinned.value]))
    }

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

    const res = await fetch(`/api/notes/${encodeURIComponent(titleToDelete)}`, {
      method: 'DELETE'
    })

    let payload: { error?: string } | null = null
    try {
      payload = (await res.json()) as { error?: string }
    } catch {
      payload = null
    }

    if (!res.ok) throw new Error(payload?.error || 'Kunne ikke slette note')

    await deleteCachedNote(titleToDelete)
    pinned.value.delete(titleToDelete)
    localStorage.setItem(PINNED_KEY, JSON.stringify([...pinned.value]))

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
    noteContents,
    updateSyncStatus,
    setSyncError,
    clearSyncError,
    setOnline,
    togglePin,
    refreshStateFromCache,
    initialize,
    selectNote,
    queueWrite,
    flushPendingWrites,
    setCurrentContent,
    pushDirtyNote,
    saveCurrent,
    syncWithServer,
    generateDefaultTitle,
    createNote,
    renameCurrent,
    deleteCurrent
  }
})

export type NotesStore = ReturnType<typeof useNotesStore>
