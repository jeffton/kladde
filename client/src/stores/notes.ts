import { computed, ref } from "vue";
import { defineStore } from "pinia";
import {
  deleteCachedNote,
  getAllCachedNotes,
  getCachedNote,
  getPendingOps,
  putCachedNote,
  replacePendingOps,
} from "./notesDb";
import type { CachedNote, NoteMeta, NoteResponse, PendingOp, SyncState } from "../types";
import { t } from "../i18n";
import { apiFetch, clientOrigin, isNotFoundError, notePathApi } from "./notesApi";
import { createNotesWebSocket } from "./notesWebSocket";
import { createNotesPersist } from "./notesPersist";
import { createNotesSync } from "./notesSync";
import {
  emitUnauthorizedEvent,
  isNetworkError,
  isUnauthorizedError,
  toUserSyncError,
} from "./notesErrors";
import {
  buildNoteKey,
  isServerBacked,
  newerTs,
  normalizeCollection,
  normalizeNoteKey,
  normalizeTs,
  resolveUniqueTitle,
  retargetPendingKey,
  samePendingOp,
  splitNoteKey,
  toMeta,
  tsMs,
} from "./notesModel";

function normalizeServerNote(note: NoteResponse): CachedNote {
  const collection = normalizeCollection(note.collection);
  const title = note.title.trim();

  return {
    key: note.key.trim(),
    title,
    collection,
    content: note.content,
    updatedAt: normalizeTs(note.updatedAt),
    dirty: false,
    starred: Boolean(note.starred),
    existsOnServer: true,
  };
}

export const useNotesStore = defineStore("notes", () => {
  const notes = ref<NoteMeta[]>([]);
  const selectedKey = ref("");
  const currentContent = ref("");
  const currentUpdatedAt = ref<string | null>(null);
  const pinned = computed(() => new Set(notes.value.filter((n) => n.starred).map((n) => n.key)));
  const dirty = ref(false);
  const online = ref(navigator.onLine);
  const syncStatus = ref(t("syncedShort"));
  const syncing = ref(false);
  const syncError = ref("");
  const syncState = computed<SyncState>(() => {
    if (!online.value) return "offline";
    if (syncing.value) return "syncing";
    if (syncError.value) return "error";
    return "synced";
  });
  const contentVersion = ref(0);
  const noteContents = ref<Record<string, string>>({});
  const pendingOps = ref<PendingOp[]>([]);
  let syncRetryTimer: number | null = null;
  let syncRetryAttempt = 0;
  const wsConnected = ref(false);

  const selectedNote = computed(
    () => notes.value.find((note) => note.key === selectedKey.value) || null,
  );
  const selectedTitle = computed(() => selectedNote.value?.title || "");
  const selectedCollection = computed(() => selectedNote.value?.collection || "");

  const collections = computed(() => {
    const collator = new Intl.Collator(
      typeof navigator !== "undefined" ? navigator.language : "en-US",
      { sensitivity: "base" },
    );
    const all = Array.from(
      new Set(notes.value.map((note) => note.collection).filter((value) => Boolean(value))),
    );
    all.sort((a, b) => collator.compare(a, b));
    return all;
  });

  const sortedNotes = computed(() => {
    return [...notes.value].sort((a, b) => {
      const aPinned = pinned.value.has(a.key);
      const bPinned = pinned.value.has(b.key);
      if (aPinned !== bPinned) return aPinned ? -1 : 1;
      return tsMs(b.updatedAt) - tsMs(a.updatedAt);
    });
  });

  const isActiveNoteLocallyDirty = (key: string) => {
    return selectedKey.value === key && dirty.value;
  };

  const updateSyncStatus = () => {
    switch (syncState.value) {
      case "offline":
        syncStatus.value = t("syncOfflineLocal");
        break;
      case "syncing":
        syncStatus.value = t("syncingShort");
        break;
      case "error":
        syncStatus.value = `${t("syncErrorPrefix")}: ${syncError.value}`;
        break;
      default:
        syncStatus.value = t("syncedShort");
    }
  };

  const setSyncError = (message: string) => {
    syncError.value = message || t("unknownError");
    updateSyncStatus();
  };

  const handleSyncFailure = (err: unknown, fallback: string) => {
    if (isUnauthorizedError(err)) {
      clearSyncRetry();
      clearSyncError();
      emitUnauthorizedEvent();
      return;
    }

    if (isNetworkError(err) && typeof navigator !== "undefined" && !navigator.onLine) {
      online.value = false;
      clearSyncError();
      updateSyncStatus();
      return;
    }

    setSyncError(toUserSyncError(err, fallback));
    if (isNetworkError(err)) scheduleSyncRetry();
  };

  const clearSyncError = () => {
    syncError.value = "";
    updateSyncStatus();
  };

  const clearSyncRetry = () => {
    if (syncRetryTimer !== null) {
      window.clearTimeout(syncRetryTimer);
      syncRetryTimer = null;
    }
    syncRetryAttempt = 0;
  };

  const scheduleSyncRetry = () => {
    if (!online.value || syncRetryTimer !== null) return;
    const baseDelay = 2000;
    const maxDelay = 60000;
    const expDelay = Math.min(maxDelay, baseDelay * 2 ** syncRetryAttempt);
    const jitter = Math.floor(Math.random() * 500);
    const delay = expDelay + jitter;

    syncRetryTimer = window.setTimeout(() => {
      syncRetryTimer = null;
      triggerBackgroundSync();
    }, delay);

    syncRetryAttempt = Math.min(syncRetryAttempt + 1, 8);
  };

  const triggerBackgroundSync = () => {
    void syncWithServer();
  };

  const { queueWrite, flushPendingWrites, setCurrentContent } = createNotesPersist({
    selectedKey,
    currentContent,
    currentUpdatedAt,
    dirty,
    contentVersion,
    notes,
    noteContents,
    getCachedNote,
    putCachedNote,
    updateSyncStatus,
    onPersistError: (err) => {
      handleSyncFailure(err, t("couldNotSaveLocally"));
    },
  });

  const setOnline = (value: boolean) => {
    online.value = value;
    updateSyncStatus();
    if (value) {
      clearSyncRetry();
      triggerBackgroundSync();
      void connectWebSocket();
      return;
    }
    clearSyncRetry();
    disconnectWebSocket();
  };

  const togglePin = async (key: string) => {
    const note = notes.value.find((n) => n.key === key);
    if (!note) return;

    const nextStarred = !note.starred;
    note.starred = nextStarred;

    await queueWrite(async () => {
      const cached = await getCachedNote(key);
      if (!cached) return;
      await putCachedNote({ ...cached, starred: nextStarred });
    });

    await mutatePendingOps((ops) => {
      if (ops.some((op) => op.type === "delete" && op.key === key)) return ops;

      const next = [...ops];
      const existingIdx = next.findIndex((op) => op.type === "star" && op.key === key);
      if (existingIdx === -1) {
        next.push({ type: "star", key, starred: nextStarred });
      } else {
        next[existingIdx] = { type: "star", key, starred: nextStarred };
      }
      return next;
    });

    if (online.value) {
      triggerBackgroundSync();
    }
  };

  const refreshStateFromCache = async () => {
    const cached = await getAllCachedNotes();
    const activeKey = selectedKey.value;
    const cachedByKey = new Map(cached.map((n) => [normalizeNoteKey(n), n]));

    const newNotes = cached.filter((n) => normalizeNoteKey(n) !== activeKey).map(toMeta);
    const newNoteContents: Record<string, string> = Object.fromEntries(
      cached
        .filter((n) => normalizeNoteKey(n) !== activeKey)
        .map((n) => [normalizeNoteKey(n), n.content || ""]),
    );

    if (activeKey) {
      const inMemoryActive = notes.value.find((n) => n.key === activeKey);
      const cachedActive = cachedByKey.get(activeKey);
      const fallbackRef = splitNoteKey(activeKey);
      const isLocallyDirty = dirty.value || Boolean(inMemoryActive?.dirty);
      const cachedUpdatedAt = normalizeTs(cachedActive?.updatedAt);
      const inMemoryUpdatedAt = normalizeTs(currentUpdatedAt.value);

      const activeMeta: NoteMeta = inMemoryActive
        ? {
            ...inMemoryActive,
            key: activeKey,
            dirty: isLocallyDirty,
            updatedAt: isLocallyDirty
              ? inMemoryUpdatedAt || cachedUpdatedAt
              : cachedUpdatedAt || inMemoryUpdatedAt,
          }
        : {
            key: activeKey,
            title: cachedActive?.title || fallbackRef.title,
            collection: normalizeCollection(cachedActive?.collection || fallbackRef.collection),
            updatedAt: isLocallyDirty
              ? inMemoryUpdatedAt || cachedUpdatedAt
              : cachedUpdatedAt || inMemoryUpdatedAt,
            dirty: isLocallyDirty || Boolean(cachedActive?.dirty),
            starred: Boolean(cachedActive?.starred),
          };

      newNotes.push(activeMeta);

      newNoteContents[activeKey] = isLocallyDirty
        ? (noteContents.value[activeKey] ?? currentContent.value ?? cachedActive?.content ?? "")
        : (cachedActive?.content ?? currentContent.value ?? noteContents.value[activeKey] ?? "");
    }

    notes.value = newNotes;
    noteContents.value = newNoteContents;

    if (!selectedKey.value && cached.length > 0) {
      const latest = cached.sort((a, b) => tsMs(b.updatedAt) - tsMs(a.updatedAt))[0];
      selectedKey.value = normalizeNoteKey(latest);
    }

    if (selectedKey.value && !dirty.value) {
      const selectedMeta = notes.value.find((n) => n.key === selectedKey.value);
      currentContent.value = noteContents.value[selectedKey.value] || "";
      currentUpdatedAt.value = selectedMeta?.updatedAt || null;
      dirty.value = Boolean(selectedMeta?.dirty);
    }
  };

  const initialize = async () => {
    const storedOps = await getPendingOps();
    pendingOps.value = storedOps.map((storedOp) => {
      const { id, ...op } = storedOp;
      void id;
      return op;
    });

    await refreshStateFromCache();
    updateSyncStatus();
    if (online.value) {
      triggerBackgroundSync();
    }
    void connectWebSocket();
  };

  const hydrateSelectedNoteFromCache = (cached: CachedNote | undefined) => {
    if (cached) {
      currentContent.value = cached.content || "";
      currentUpdatedAt.value = cached.updatedAt ? normalizeTs(cached.updatedAt) : null;
      dirty.value = Boolean(cached.dirty);
      return;
    }

    currentContent.value = "";
    currentUpdatedAt.value = null;
    dirty.value = false;
  };

  const refreshSelectedNoteFromServer = async (key: string, cached: CachedNote | undefined) => {
    if (!online.value) return;

    const ref = cached || splitNoteKey(key);

    try {
      const noteRes = await apiFetch(notePathApi(ref.title, ref.collection));
      const serverNote = normalizeServerNote((await noteRes.json()) as NoteResponse);
      const latestLocal = await getCachedNote(key);

      if (!latestLocal?.dirty) {
        if (serverNote.key !== key) {
          await deleteCachedNote(key);
        }

        await putCachedNote({
          ...serverNote,
          dirty: false,
          existsOnServer: true,
        });
      }

      if (selectedKey.value === key && !dirty.value) {
        currentContent.value = serverNote.content || "";
        currentUpdatedAt.value = normalizeTs(serverNote.updatedAt);
        dirty.value = false;
        if (serverNote.key !== key) {
          selectedKey.value = serverNote.key;
        }
      }

      await refreshStateFromCache();
      clearSyncError();
    } catch (err: unknown) {
      if (!isNotFoundError(err)) {
        handleSyncFailure(err, t("couldNotFetchNote"));
      }
      triggerBackgroundSync();
    }
  };

  const selectNote = async (key: string) => {
    await flushPendingWrites();
    selectedKey.value = key;

    const cached = await getCachedNote(key);
    hydrateSelectedNoteFromCache(cached);

    if (!online.value) return;

    void refreshSelectedNoteFromServer(key, cached);
  };

  const applyLocalRename = async (
    oldKey: string,
    desiredTitle: string,
    desiredCollection: string,
  ) => {
    const local = await getCachedNote(oldKey);
    if (!local) throw new Error(t("noNoteSelected"));

    const normalizedCollection = normalizeCollection(desiredCollection);
    const targetTitle = resolveUniqueTitle(
      new Set(
        notes.value
          .filter((note) => note.collection === normalizedCollection && note.key !== oldKey)
          .map((note) => note.title),
      ),
      desiredTitle,
    );
    const targetKey = buildNoteKey(targetTitle, normalizedCollection);

    if (targetKey === oldKey) return targetKey;

    const renamed: CachedNote = {
      ...local,
      key: targetKey,
      title: targetTitle,
      collection: normalizedCollection,
      dirty: Boolean(local.dirty),
      existsOnServer: local.existsOnServer,
    };

    await queueWrite(async () => {
      await putCachedNote(renamed);
      await deleteCachedNote(oldKey);
    });

    if (selectedKey.value === oldKey) {
      selectedKey.value = targetKey;
      currentContent.value = renamed.content || "";
      currentUpdatedAt.value = normalizeTs(renamed.updatedAt);
      dirty.value = Boolean(renamed.dirty);
    }

    await refreshStateFromCache();
    return targetKey;
  };

  const clearCurrentSelection = () => {
    selectedKey.value = "";
    currentContent.value = "";
    currentUpdatedAt.value = null;
    dirty.value = false;
  };

  let resetWsFailuresAndReconnect: () => void = () => undefined;

  const { mutatePendingOps, saveCurrent, syncWithServer } = createNotesSync({
    pendingOps,
    selectedKey,
    currentContent,
    currentUpdatedAt,
    dirty,
    notes,
    online,
    syncing,
    getCachedNote,
    getAllCachedNotes,
    putCachedNote,
    deleteCachedNote,
    replacePendingOps,
    queueWrite,
    flushPendingWrites,
    refreshStateFromCache,
    isActiveNoteLocallyDirty,
    isServerBacked,
    samePendingOp,
    retargetPendingKey,
    normalizeTs,
    newerTs,
    tsMs,
    apiFetch,
    isNotFoundError,
    resetWsFailuresAndReconnect: () => resetWsFailuresAndReconnect(),
    updateSyncStatus,
    clearSyncRetry,
    clearSyncError,
    handleSyncFailure,
  });

  const wsController = createNotesWebSocket({
    online,
    wsConnected,
    clientOrigin,
    selectedKey,
    currentContent,
    currentUpdatedAt,
    dirty,
    apiFetch,
    syncWithServer,
    refreshStateFromCache,
    getCachedNote,
    putCachedNote,
    deleteCachedNote,
    normalizeTs,
    isServerBacked,
    isActiveNoteLocallyDirty,
  });
  const { connectWebSocket, disconnectWebSocket } = wsController;
  resetWsFailuresAndReconnect = wsController.resetWsFailuresAndReconnect;

  const generateDefaultTitle = (base = t("newNote"), collection = "") => {
    const normalizedCollection = normalizeCollection(collection);
    const existing = new Set(
      notes.value
        .filter((note) => note.collection === normalizedCollection)
        .map((note) => note.title),
    );
    if (!existing.has(base)) return base;
    let i = 2;
    while (existing.has(`${base} ${i}`)) i += 1;
    return `${base} ${i}`;
  };

  const createNote = async (title = "", collection = "") => {
    const normalizedCollection = normalizeCollection(collection);
    const resolvedTitle = (
      title || generateDefaultTitle(t("newNote"), normalizedCollection)
    ).trim();
    if (!resolvedTitle) throw new Error(t("titleRequired"));

    const key = buildNoteKey(resolvedTitle, normalizedCollection);

    await putCachedNote({
      key,
      title: resolvedTitle,
      collection: normalizedCollection,
      content: "",
      updatedAt: new Date().toISOString(),
      dirty: true,
      existsOnServer: false,
    });

    await refreshStateFromCache();
    await selectNote(key);

    if (!online.value) {
      updateSyncStatus();
      return key;
    }

    triggerBackgroundSync();
    return key;
  };

  const renameCurrent = async (newTitle: string, collectionOverride?: string) => {
    await flushPendingWrites();
    if (!selectedKey.value) throw new Error(t("noNoteSelected"));
    const oldKey = selectedKey.value;
    const requestedTitle = (newTitle || "").trim();

    if (!requestedTitle) throw new Error(t("titleRequired"));

    const local = await getCachedNote(oldKey);
    if (!local) throw new Error(t("noNoteSelected"));

    const targetCollection = normalizeCollection(collectionOverride ?? local.collection);
    if (requestedTitle === local.title && targetCollection === local.collection) {
      return oldKey;
    }

    const wasServerBacked = isServerBacked(local);
    const renamedKey = await applyLocalRename(oldKey, requestedTitle, targetCollection);

    await mutatePendingOps((ops) => {
      const chainIdx = ops.findIndex((op) => op.type === "rename" && op.newKey === oldKey);
      let next = retargetPendingKey(ops, oldKey, renamedKey);

      if (wasServerBacked && chainIdx === -1) {
        next = [...next, { type: "rename", oldKey, newKey: renamedKey }];
      }

      return next;
    });

    if (online.value) {
      triggerBackgroundSync();
    }

    return renamedKey;
  };

  const moveCurrentToCollection = async (nextCollection: string) => {
    if (!selectedKey.value) throw new Error(t("noNoteSelected"));
    const current = selectedNote.value || splitNoteKey(selectedKey.value);
    return renameCurrent(current.title, normalizeCollection(nextCollection));
  };

  const deleteCurrent = async () => {
    await flushPendingWrites();
    if (!selectedKey.value) throw new Error(t("noNoteSelected"));
    const keyToDelete = selectedKey.value;
    const local = await getCachedNote(keyToDelete);
    const likelyServerBacked = isServerBacked(local);

    await queueWrite(async () => {
      await deleteCachedNote(keyToDelete);
    });

    clearCurrentSelection();
    await refreshStateFromCache();

    await mutatePendingOps((ops) => {
      let deleteTarget = keyToDelete;
      let shouldDeleteOnServer = likelyServerBacked;

      const next = ops.filter((op) => {
        if (op.type === "star" && op.key === keyToDelete) return false;
        return true;
      });

      const renameToDeleted = next.find((op) => op.type === "rename" && op.newKey === keyToDelete);
      let pruned = next;

      if (renameToDeleted && renameToDeleted.type === "rename") {
        deleteTarget = renameToDeleted.oldKey;
        shouldDeleteOnServer = true;
        pruned = pruned.filter(
          (op) =>
            !(
              op.type === "rename" &&
              op.oldKey === renameToDeleted.oldKey &&
              op.newKey === renameToDeleted.newKey
            ),
        );
      }

      pruned = pruned.filter((op) => {
        if (op.type === "star" && (op.key === deleteTarget || op.key === keyToDelete)) return false;
        if (op.type === "delete" && (op.key === keyToDelete || op.key === deleteTarget))
          return false;
        if (op.type === "rename" && (op.oldKey === keyToDelete || op.newKey === keyToDelete))
          return false;
        return true;
      });

      if (shouldDeleteOnServer) {
        pruned.push({ type: "delete", key: deleteTarget });
      }

      return pruned;
    });

    if (online.value) {
      triggerBackgroundSync();
    }
  };

  return {
    notes,
    sortedNotes,
    collections,
    selectedNote,
    selectedKey,
    selectedTitle,
    selectedCollection,
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
    moveCurrentToCollection,
    deleteCurrent,
  };
});

export type NotesStore = ReturnType<typeof useNotesStore>;
