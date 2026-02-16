import { onMounted, onUnmounted } from 'vue'

export function useAutosave({ store, onError }) {
  let autosaveTimer = null
  let syncTimer = null

  const flush = () => {
    if (!store.selectedTitle) return
    void store.flushPendingWrites()
    if (store.dirty) {
      void store.saveCurrent().catch((err) => {
        onError?.(err)
      })
    }
  }

  const beforeUnloadHandler = () => {
    flush()
  }

  const pageHideHandler = () => {
    flush()
  }

  onMounted(() => {
    autosaveTimer = setInterval(async () => {
      if (!store.dirty) return
      try {
        await store.saveCurrent()
      } catch (err) {
        onError?.(err)
      }
    }, 2500)

    syncTimer = setInterval(async () => {
      if (!store.online) return
      try {
        await store.syncWithServer()
      } catch (err) {
        onError?.(err)
      }
    }, 15000)

    window.addEventListener('beforeunload', beforeUnloadHandler)
    window.addEventListener('pagehide', pageHideHandler)
  })

  onUnmounted(() => {
    clearInterval(autosaveTimer)
    clearInterval(syncTimer)
    window.removeEventListener('beforeunload', beforeUnloadHandler)
    window.removeEventListener('pagehide', pageHideHandler)
  })

  return {
    flushNow: flush
  }
}
