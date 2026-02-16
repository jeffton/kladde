import { defineStore } from 'pinia'

const PINNED_KEY = 'noteapp:pinned'

function loadPinned() {
  try {
    return new Set(JSON.parse(localStorage.getItem(PINNED_KEY) || '[]'))
  } catch {
    return new Set()
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
    saveStatus: ''
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
    setOnline(value) {
      this.online = value
    },
    togglePin(title) {
      if (this.pinned.has(title)) this.pinned.delete(title)
      else this.pinned.add(title)
      localStorage.setItem(PINNED_KEY, JSON.stringify([...this.pinned]))
    },
    async fetchNotes() {
      const res = await fetch('/api/notes')
      if (!res.ok) throw new Error('Kunne ikke hente noter')
      const notes = await res.json()
      this.notes = notes

      if (!this.selectedTitle && notes.length > 0) {
        await this.selectNote(notes[0].title)
      }

      if (this.selectedTitle) {
        const selectedMeta = notes.find((n) => n.title === this.selectedTitle)
        if (!selectedMeta) return

        const serverTime = new Date(selectedMeta.updatedAt).getTime()
        const localTime = this.currentUpdatedAt ? new Date(this.currentUpdatedAt).getTime() : 0
        if (!this.dirty && serverTime > localTime) {
          await this.selectNote(this.selectedTitle)
        }
      }
    },
    async selectNote(title) {
      this.selectedTitle = title
      const res = await fetch(`/api/notes/${encodeURIComponent(title)}`)
      if (!res.ok) throw new Error('Kunne ikke hente noten')
      const note = await res.json()
      this.currentContent = note.content
      this.currentUpdatedAt = note.updatedAt
      this.dirty = false
    },
    setCurrentContent(content) {
      this.currentContent = content
      this.dirty = true
    },
    async saveCurrent() {
      if (!this.selectedTitle) return
      this.saveStatus = 'Gemmer…'
      const res = await fetch(`/api/notes/${encodeURIComponent(this.selectedTitle)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: this.currentContent })
      })
      if (!res.ok) {
        this.saveStatus = 'Fejl ved gem'
        throw new Error('Save failed')
      }
      const note = await res.json()
      this.currentUpdatedAt = note.updatedAt
      this.dirty = false
      this.saveStatus = 'Gemt'
      await this.fetchNotes()
    },
    async createNote(title) {
      const res = await fetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, content: `# ${title}\n\nNy note.` })
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Ukendt fejl' }))
        throw new Error(err.error || 'Kunne ikke oprette note')
      }
      await this.fetchNotes()
      await this.selectNote(title)
    }
  }
})
