import { onMounted, onUnmounted } from "vue";
import type { NotesStore } from "../stores/notes";

interface UseAutosaveOptions {
  store: NotesStore;
  onError?: (error: unknown) => void;
}

export function useAutosave({ store, onError }: UseAutosaveOptions) {
  let autosaveTimer: number | null = null;
  let syncTimer: number | null = null;
  let autosaveInProgress = false;
  let syncInProgress = false;

  const flush = () => {
    if (!store.selectedKey || !store.dirty) return;
    void store.saveCurrent().catch((err) => onError?.(err));
  };

  onMounted(() => {
    autosaveTimer = window.setInterval(async () => {
      if (autosaveInProgress || !store.dirty) return;
      autosaveInProgress = true;
      try {
        await store.saveCurrent();
      } catch (err) {
        onError?.(err);
      } finally {
        autosaveInProgress = false;
      }
    }, 2500);

    syncTimer = window.setInterval(async () => {
      if (syncInProgress || !store.online) return;
      syncInProgress = true;
      try {
        await store.syncWithServer();
      } catch (err) {
        onError?.(err);
      } finally {
        syncInProgress = false;
      }
    }, 15000);

    window.addEventListener("beforeunload", flush);
    window.addEventListener("pagehide", flush);
  });

  onUnmounted(() => {
    if (autosaveTimer !== null) window.clearInterval(autosaveTimer);
    if (syncTimer !== null) window.clearInterval(syncTimer);
    window.removeEventListener("beforeunload", flush);
    window.removeEventListener("pagehide", flush);
  });

  return { flushNow: flush };
}
