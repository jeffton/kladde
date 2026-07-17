import type { Ref } from "vue";
import type { CachedNote, NoteResponse } from "../types";
import { normalizeCollection } from "./notesModel";
import { notePathApi } from "./notesApi";
import { emitUnauthorizedEvent, isUnauthorizedError } from "./notesErrors";

interface NotesWebSocketDeps {
  online: Ref<boolean>;
  wsConnected: Ref<boolean>;
  clientOrigin: string;
  selectedKey: Ref<string>;
  currentContent: Ref<string>;
  currentUpdatedAt: Ref<string | null>;
  dirty: Ref<boolean>;
  apiFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  syncWithServer: () => Promise<void>;
  refreshStateFromCache: () => Promise<void>;
  getCachedNote: (key: string) => Promise<CachedNote | undefined>;
  putCachedNote: (note: CachedNote) => Promise<IDBValidKey>;
  deleteCachedNote: (key: string) => Promise<void>;
  queueWrite: (task: () => Promise<unknown>) => Promise<unknown>;
  normalizeTs: (value?: string | null) => string;
  isServerBacked: (note?: CachedNote | null) => boolean;
  isActiveNoteLocallyDirty: (key: string) => boolean;
  getSessionGeneration: () => number;
}

function normalizeServerNote(note: NoteResponse): CachedNote {
  const collection = normalizeCollection(note.collection);
  const title = note.title.trim();

  return {
    key: note.key.trim(),
    title,
    collection,
    content: note.content,
    updatedAt: note.updatedAt,
    dirty: false,
    starred: Boolean(note.starred),
    existsOnServer: true,
  };
}

export function createNotesWebSocket(deps: NotesWebSocketDeps) {
  let ws: WebSocket | null = null;
  let wsReconnectTimer: number | null = null;
  let wsReconnectAttempt = 0;
  let wsReconnectDisabled = false;
  let manuallyDisconnected = true;
  let wsGeneration = 0;
  let lastMeUnauthorized = false;
  const pendingRemoteChanges = new Map<
    string,
    { title: string; collection: string; action: string }
  >();
  let remoteChangeTimer: number | null = null;

  const clearWsReconnect = () => {
    if (wsReconnectTimer !== null) {
      window.clearTimeout(wsReconnectTimer);
      wsReconnectTimer = null;
    }
  };

  const handleRemoteDelete = async (key: string, generation: number) => {
    let deleted = false;
    await deps.queueWrite(async () => {
      if (generation !== deps.getSessionGeneration()) return;
      const local = await deps.getCachedNote(key);
      if (generation !== deps.getSessionGeneration()) return;
      if (deps.isActiveNoteLocallyDirty(key)) return;
      if (local && !deps.isServerBacked(local)) return;

      if (local && !local.dirty) {
        await deps.deleteCachedNote(key);
      }
      deleted = true;
    });
    if (!deleted || generation !== deps.getSessionGeneration()) return;

    if (deps.selectedKey.value === key) {
      deps.selectedKey.value = "";
      deps.currentContent.value = "";
      deps.currentUpdatedAt.value = null;
      deps.dirty.value = false;
    }
    await deps.refreshStateFromCache();
  };

  const handleRemoteNoteChange = async (
    key: string,
    title: string,
    collection: string,
    action: string,
    generation: number,
  ) => {
    if (action === "deleted") {
      await handleRemoteDelete(key, generation);
      return;
    }

    if (deps.isActiveNoteLocallyDirty(key)) return;

    try {
      const noteRes = await deps.apiFetch(notePathApi(title, collection));
      const serverNote = normalizeServerNote((await noteRes.json()) as NoteResponse);
      if (generation !== deps.getSessionGeneration()) return;

      await deps.queueWrite(async () => {
        if (generation !== deps.getSessionGeneration()) return;
        const local = await deps.getCachedNote(key);
        if (generation !== deps.getSessionGeneration()) return;
        if (local?.dirty || deps.isActiveNoteLocallyDirty(key)) return;

        if (serverNote.key !== key) {
          await deps.deleteCachedNote(key);
        }

        await deps.putCachedNote({
          ...serverNote,
          updatedAt: deps.normalizeTs(serverNote.updatedAt),
          dirty: false,
          starred: Boolean(serverNote.starred),
          existsOnServer: true,
        });
      });
    } catch {
      if (generation !== deps.getSessionGeneration()) return;
      // If note disappeared between event and fetch, reconcile via full sync.
      if (action === "created" || action === "updated") {
        void deps.syncWithServer();
      }
    }
  };

  const queueRemoteChange = (key: string, title: string, collection: string, action: string) => {
    pendingRemoteChanges.set(key, { title, collection, action });
    if (remoteChangeTimer !== null) window.clearTimeout(remoteChangeTimer);
    remoteChangeTimer = window.setTimeout(() => {
      remoteChangeTimer = null;
      const changes = Array.from(pendingRemoteChanges.entries());
      pendingRemoteChanges.clear();

      void (async () => {
        const generation = deps.getSessionGeneration();
        for (const [changedKey, changed] of changes) {
          await handleRemoteNoteChange(
            changedKey,
            changed.title,
            changed.collection,
            changed.action,
            generation,
          );
        }
        if (generation !== deps.getSessionGeneration()) return;
        await deps.refreshStateFromCache();
      })().catch(() => {
        void deps.syncWithServer();
      });
    }, 200);
  };

  const scheduleWsReconnect = () => {
    if (wsReconnectDisabled || wsReconnectTimer !== null) return;
    const delay = Math.min(30000, 1000 * 2 ** wsReconnectAttempt);
    wsReconnectTimer = window.setTimeout(() => {
      wsReconnectTimer = null;
      void connectWebSocket();
    }, delay);
    wsReconnectAttempt = Math.min(wsReconnectAttempt + 1, 5);
  };

  const connectWebSocket = async () => {
    manuallyDisconnected = false;
    if (!deps.online.value || wsReconnectDisabled) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/client-api/ws`;
    const generation = wsGeneration;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      scheduleWsReconnect();
      return;
    }

    const socket = ws;
    ws.onopen = () => {
      deps.wsConnected.value = true;
      wsReconnectAttempt = 0;
      wsReconnectDisabled = false;
      lastMeUnauthorized = false;
      clearWsReconnect();
      void deps.syncWithServer();
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data)) as {
          type: string;
          key: string;
          title: string;
          collection?: string;
          action: string;
          origin?: string;
        };
        if (payload.type === "note_changed") {
          if (payload.origin && payload.origin === deps.clientOrigin) return;

          const collection = normalizeCollection(payload.collection);
          queueRemoteChange(payload.key.trim(), payload.title.trim(), collection, payload.action);
        }
      } catch {
        // ignore malformed payloads
      }
    };

    ws.onclose = (event) => {
      if (generation !== wsGeneration) return;

      deps.wsConnected.value = false;
      if (ws === socket) ws = null;

      if (event.code === 1008) {
        wsReconnectDisabled = true;
        return;
      }

      void (async () => {
        try {
          await deps.apiFetch("/client-api/me");
          lastMeUnauthorized = false;
        } catch (err: unknown) {
          lastMeUnauthorized = isUnauthorizedError(err);
        }

        if (lastMeUnauthorized) {
          wsReconnectDisabled = true;
          emitUnauthorizedEvent();
          return;
        }

        scheduleWsReconnect();
      })();
    };

    ws.onerror = () => {
      deps.wsConnected.value = false;
    };
  };

  const resetWsFailuresAndReconnect = () => {
    if (manuallyDisconnected) return;
    wsReconnectDisabled = false;
    lastMeUnauthorized = false;
    wsReconnectAttempt = 0;
    clearWsReconnect();
    if (deps.online.value && !deps.wsConnected.value) {
      void connectWebSocket();
    }
  };

  const disconnectWebSocket = () => {
    manuallyDisconnected = true;
    wsGeneration += 1;
    deps.wsConnected.value = false;
    if (ws) {
      ws.close();
      ws = null;
    }
    clearWsReconnect();
    if (remoteChangeTimer !== null) {
      window.clearTimeout(remoteChangeTimer);
      remoteChangeTimer = null;
    }
    pendingRemoteChanges.clear();
  };

  return {
    connectWebSocket,
    resetWsFailuresAndReconnect,
    disconnectWebSocket,
  };
}
