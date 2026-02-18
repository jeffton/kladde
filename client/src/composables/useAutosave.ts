import { onMounted, onUnmounted } from 'vue'
import type { NotesStore } from '../stores/notes'

interface UseAutosaveOptions {
  store: NotesStore
  onError?: (error: unknown) => void
}

export function useAutosave({ store, onError }: UseAutosaveOptions) {
  let autosaveTimer: number | null = null
  let syncTimer: number | null = null

  const flush = () => {
    if (!store.selectedTitle || !store.dirty) return
    void store.saveCurrent().catch((err) => onError?.(err))
  }

  onMounted(() => {
    autosaveTimer = window.setInterval(async () => {
      if (!store.dirty) return
      try {
        await store.saveCurrent()
      } catch (err) {
        onError?.(err)
      }
    }, 2500)

    syncTimer = window.setInterval(async () => {
      if (!store.online) return
      try {
        await store.syncWithServer()
      } catch (err) {
        onError?.(err)
      }
    }, 15000)

    window.addEventListener('beforeunload', flush)
    window.addEventListener('pagehide', flush)
  })

  onUnmounted(() => {
    if (autosaveTimer !== null) window.clearInterval(autosaveTimer)
    if (syncTimer !== null) window.clearInterval(syncTimer)
    window.removeEventListener('beforeunload', flush)
    window.removeEventListener('pagehide', flush)
  })

  return { flushNow: flush }
}
