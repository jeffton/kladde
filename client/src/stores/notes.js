import { defineStore } from 'pinia'
import { deleteCachedNote, getAllCachedNotes, getCachedNote, putCachedNote, putCachedNotes } from './notesDb'

const PINNED_KEY = 'noteapp:pinned'

function loadPinned() {
  try {
    return new Set(JSON.parse(localStorage.getItem(PINNED_KEY) || '[]'))
  } catch {
    return new Set()
  }
}

function normalizeTs(value) {
  return value ? new Date(value).toISOString() : new Date().toISOString()
}

function toMeta(note) {
  return {
    title: note.title,
    updatedAt: normalizeTs(note.updatedAt),
    dirty: Boolean(note.dirty)
  }
}

export const useNotesStore = defineStore('notes', {
  state: () => ({
    notes: [],
    selectedTitle: '',
    currentContent: '',
    currentUpdatedAt: null,
    pinned: loadPinned(),
    dirty: false,
    online: navigator.onLine,
    syncStatus: 'Synkroniseret',
    syncing: false
  }),
  getters: {
    sortedNotes(state) {
      return [...state.notes].sort((a, b) => {
        const aPinned = state.pinned.has(a.title)
        const bPinned = state.pinned.has(b.title)
        if (aPinned !== bPinned) return aPinned ? -1 : 1
        return new Date(b.updatedAt) - new Date(a.updatedAt)
      })
    }
  },
  actions: {
    updateSyncStatus() {
      if (!this.online) {
        this.syncStatus = 'Offline — ændringer gemmes lokalt'
      } else if (this.syncing) {
        this.syncStatus = 'Synkroniserer...'
      } else {
        this.syncStatus = 'Synkroniseret'
      }
    },

    setOnline(value) {
      this.online = value
      this.updateSyncStatus()
      if (value) {
        this.syncWithServer().catch(() => {})
      }
    },

    togglePin(title) {
      if (this.pinned.has(title)) this.pinned.delete(title)
      else this.pinned.add(title)
      localStorage.setItem(PINNED_KEY, JSON.stringify([...this.pinned]))
    },

    async refreshStateFromCache() {
      const cached = await getAllCachedNotes()
      this.notes = cached.map(toMeta)

      if (!this.selectedTitle && cached.length > 0) {
        this.selectedTitle = cached.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0].title
      }

      if (this.selectedTitle) {
        const selected = cached.find((n) => n.title === this.selectedTitle)
        if (selected) {
          this.currentContent = selected.content || ''
          this.currentUpdatedAt = normalizeTs(selected.updatedAt)
          this.dirty = Boolean(selected.dirty)
        }
      }
    },

    async initialize() {
      await this.refreshStateFromCache()
      this.updateSyncStatus()

      if (this.online) {
        this.syncWithServer().catch(() => {})
      }
    },

    async selectNote(title) {
      this.selectedTitle = title

      const cached = await getCachedNote(title)
      if (cached) {
        this.currentContent = cached.content || ''
        this.currentUpdatedAt = normalizeTs(cached.updatedAt)
        this.dirty = Boolean(cached.dirty)
      } else {
        this.currentContent = ''
        this.currentUpdatedAt = null
        this.dirty = false
      }

      if (this.online && !cached) {
        this.syncWithServer().catch(() => {})
      }
    },

    async setCurrentContent(content) {
      this.currentContent = content
      this.dirty = true
      this.currentUpdatedAt = new Date().toISOString()

      if (!this.selectedTitle) return

      await putCachedNote({
        title: this.selectedTitle,
        content: this.currentContent,
        updatedAt: this.currentUpdatedAt,
        dirty: true
      })

      await this.refreshStateFromCache()
      this.updateSyncStatus()
    },

    async pushDirtyNote(title) {
      const local = await getCachedNote(title)
      if (!local || !local.dirty) return

      const res = await fetch(`/api/notes/${encodeURIComponent(title)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: local.content })
      })
      if (!res.ok) throw new Error('Save failed')
      const saved = await res.json()

      await putCachedNote({
        title: saved.title,
        content: saved.content,
        updatedAt: normalizeTs(saved.updatedAt),
        dirty: false
      })

      if (this.selectedTitle === title) {
        this.currentUpdatedAt = normalizeTs(saved.updatedAt)
        this.dirty = false
      }
    },

    async saveCurrent() {
      if (!this.selectedTitle) return

      // always persist locally first (offline-first)
      await putCachedNote({
        title: this.selectedTitle,
        content: this.currentContent,
        updatedAt: this.currentUpdatedAt || new Date().toISOString(),
        dirty: true
      })

      await this.refreshStateFromCache()

      if (!this.online) {
        this.updateSyncStatus()
        return
      }

      this.syncing = true
      this.updateSyncStatus()
      try {
        await this.pushDirtyNote(this.selectedTitle)
        await this.refreshStateFromCache()
      } finally {
        this.syncing = false
        this.updateSyncStatus()
      }
    },

    async syncWithServer() {
      if (!this.online) {
        this.updateSyncStatus()
        return
      }

      this.syncing = true
      this.updateSyncStatus()

      try {
        const localNotes = await getAllCachedNotes()

        // 1) Push dirty local notes first
        for (const local of localNotes) {
          if (!local.dirty) continue
          await this.pushDirtyNote(local.title)
        }

        // 2) Pull server metadata
        const metaRes = await fetch('/api/notes')
        if (!metaRes.ok) throw new Error('Kunne ikke hente noter')
        const serverMetas = await metaRes.json()

        const currentLocalMap = new Map((await getAllCachedNotes()).map((n) => [n.title, n]))

        // 3) Merge from server where needed
        for (const serverMeta of serverMetas) {
          const local = currentLocalMap.get(serverMeta.title)
          const serverTs = new Date(serverMeta.updatedAt).getTime()
          const localTs = local ? new Date(local.updatedAt).getTime() : 0

          const shouldPull = !local || (!local.dirty && serverTs > localTs)
          if (!shouldPull) continue

          const noteRes = await fetch(`/api/notes/${encodeURIComponent(serverMeta.title)}`)
          if (!noteRes.ok) continue
          const serverNote = await noteRes.json()

          await putCachedNote({
            title: serverNote.title,
            content: serverNote.content,
            updatedAt: normalizeTs(serverNote.updatedAt),
            dirty: false
          })
        }

        await this.refreshStateFromCache()
      } finally {
        this.syncing = false
        this.updateSyncStatus()
      }
    },

    generateDefaultTitle(base = 'Ny note') {
      const existing = new Set(this.notes.map((n) => n.title))
      if (!existing.has(base)) return base

      let i = 2
      while (existing.has(`${base} ${i}`)) i += 1
      return `${base} ${i}`
    },

    async createNote(title = '') {
      const resolvedTitle = (title || this.generateDefaultTitle()).trim()
      if (!resolvedTitle) throw new Error('Titel er påkrævet')

      const localNote = {
        title: resolvedTitle,
        content: '',
        updatedAt: new Date().toISOString(),
        dirty: true
      }

      await putCachedNote(localNote)
      await this.refreshStateFromCache()
      await this.selectNote(resolvedTitle)

      if (!this.online) {
        this.updateSyncStatus()
        return resolvedTitle
      }

      this.syncWithServer().catch(() => {})
      return resolvedTitle
    },

    async renameCurrent(newTitle) {
      if (!this.selectedTitle) throw new Error('Ingen note valgt')
      const oldTitle = this.selectedTitle
      const nextTitle = (newTitle || '').trim()

      if (!nextTitle) throw new Error('Titel er påkrævet')
      if (nextTitle === oldTitle) return oldTitle
      if (!this.online) throw new Error('Du skal være online for at omdøbe noter')

      if (this.dirty) {
        await this.saveCurrent()
      }

      const res = await fetch(`/api/notes/${encodeURIComponent(oldTitle)}/rename`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newTitle: nextTitle })
      })

      let payload = null
      try {
        payload = await res.json()
      } catch {
        payload = null
      }

      if (!res.ok) {
        throw new Error(payload?.error || 'Kunne ikke omdøbe note')
      }

      const contentToPersist = payload?.content ?? this.currentContent
      const updatedAt = normalizeTs(payload?.updatedAt)

      await deleteCachedNote(oldTitle)
      await putCachedNote({
        title: nextTitle,
        content: contentToPersist,
        updatedAt,
        dirty: false
      })

      if (this.pinned.has(oldTitle)) {
        this.pinned.delete(oldTitle)
        this.pinned.add(nextTitle)
        localStorage.setItem(PINNED_KEY, JSON.stringify([...this.pinned]))
      }

      this.selectedTitle = nextTitle
      this.currentContent = contentToPersist
      this.currentUpdatedAt = updatedAt
      this.dirty = false

      await this.refreshStateFromCache()
      return nextTitle
    }
  }
})
