import { ref } from "vue";
import { describe, expect, test } from "vite-plus/test";
import type { CachedNote, NoteMeta, PendingOp } from "../types";
import { ApiError, isNotFoundError } from "./notesApi";
import { createNotesSync } from "./notesSync";
import { isServerBacked, normalizeTs, retargetPendingKey, samePendingOp, tsMs } from "./notesModel";

const UPDATED_AT = "2026-07-17T10:00:00.000Z";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function makeHarness(initialNotes: CachedNote[] = [], initialOps: PendingOp[] = []) {
  const cache = new Map(initialNotes.map((note) => [note.key, { ...note }]));
  const pendingOps = ref<PendingOp[]>([...initialOps]);
  const selectedKey = ref("");
  const currentContent = ref("");
  const currentUpdatedAt = ref<string | null>(null);
  const dirty = ref(false);
  const notes = ref<NoteMeta[]>(
    initialNotes.map(({ content: _content, ...note }) => ({ ...note })),
  );
  const online = ref(true);
  const syncing = ref(false);
  const failures: unknown[] = [];
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let apiHandler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push({ url: requestUrl(input), init });
    if (requestUrl(input) === "/client-api/notes") return jsonResponse([]);
    return jsonResponse({});
  };

  const controller = createNotesSync({
    pendingOps,
    selectedKey,
    currentContent,
    currentUpdatedAt,
    dirty,
    notes,
    online,
    syncing,
    getCachedNote: async (key) => {
      const note = cache.get(key);
      return note ? { ...note } : undefined;
    },
    getAllCachedNotes: async () => Array.from(cache.values(), (note) => ({ ...note })),
    putCachedNote: async (note) => {
      cache.set(note.key, { ...note });
      return note.key;
    },
    deleteCachedNote: async (key) => {
      cache.delete(key);
    },
    replacePendingOps: async (ops) => {
      pendingOps.value = [...ops];
    },
    queueWrite: async (task) => task(),
    flushPendingWrites: async () => undefined,
    refreshStateFromCache: async () => undefined,
    isActiveNoteLocallyDirty: (key) => selectedKey.value === key && dirty.value,
    isServerBacked,
    samePendingOp,
    retargetPendingKey,
    normalizeTs,
    tsMs,
    apiFetch: (input, init) => apiHandler(input, init),
    isNotFoundError,
    resetWsFailuresAndReconnect: () => undefined,
    updateSyncStatus: () => undefined,
    clearSyncRetry: () => undefined,
    clearSyncError: () => undefined,
    handleSyncFailure: (err) => failures.push(err),
  });

  controller.start();

  return {
    cache,
    controller,
    currentContent,
    currentUpdatedAt,
    dirty,
    failures,
    pendingOps,
    requests,
    selectedKey,
    setApiHandler(handler: typeof apiHandler) {
      apiHandler = handler;
    },
  };
}

describe("notes synchronization", () => {
  test("creates local-only notes before processing dependent star operations", async () => {
    const note: CachedNote = {
      key: "draft",
      title: "draft",
      collection: "",
      content: "local",
      updatedAt: UPDATED_AT,
      dirty: true,
      existsOnServer: false,
    };
    const harness = makeHarness([note], [{ type: "star", key: "draft", starred: true }]);

    harness.setApiHandler(async (input, init) => {
      const url = requestUrl(input);
      harness.requests.push({ url, init });
      if (url === "/client-api/notes" && init?.method === "POST") {
        return jsonResponse(
          { ...note, dirty: undefined, starred: false, updatedAt: UPDATED_AT },
          201,
        );
      }
      if (url.endsWith("/star")) return jsonResponse({ starred: true });
      if (url === "/client-api/notes") {
        return jsonResponse([{ ...note, starred: true, updatedAt: UPDATED_AT }]);
      }
      throw new Error(`unexpected request: ${url}`);
    });

    await harness.controller.syncWithServer();

    expect(harness.requests.map(({ url, init }) => `${init?.method || "GET"} ${url}`)).toEqual([
      "POST /client-api/notes",
      "PUT /client-api/notes/draft/star",
      "GET /client-api/notes",
    ]);
    expect(harness.pendingOps.value).toEqual([]);
    expect(harness.cache.get("draft")?.dirty).toBe(false);
  });

  test("saves the captured note from cache when selection changes during a flush", async () => {
    const note: CachedNote = {
      key: "a",
      title: "a",
      collection: "",
      content: "A draft",
      updatedAt: UPDATED_AT,
      dirty: true,
      existsOnServer: true,
    };
    const harness = makeHarness([note]);
    harness.selectedKey.value = "a";
    harness.currentContent.value = "A draft";
    harness.currentUpdatedAt.value = UPDATED_AT;
    harness.dirty.value = true;

    harness.setApiHandler(async (input, init) => {
      harness.requests.push({ url: requestUrl(input), init });
      return jsonResponse({ ...note, starred: false });
    });

    const save = harness.controller.saveCurrent();
    harness.selectedKey.value = "b";
    harness.currentContent.value = "B draft";
    await save;

    const requestBody = harness.requests[0]?.init?.body;
    expect(typeof requestBody).toBe("string");
    const body = JSON.parse(requestBody as string) as { content: string };
    expect(body.content).toBe("A draft");
    expect(harness.cache.get("a")?.content).toBe("A draft");
  });

  test("persists the captured draft before pushing when the cache entry is missing", async () => {
    const harness = makeHarness();
    harness.selectedKey.value = "draft";
    harness.currentContent.value = "uncached draft";
    harness.currentUpdatedAt.value = UPDATED_AT;
    harness.dirty.value = true;

    harness.setApiHandler(async (input, init) => {
      harness.requests.push({ url: requestUrl(input), init });
      return jsonResponse({
        key: "draft",
        title: "draft",
        collection: "",
        content: "uncached draft",
        updatedAt: UPDATED_AT,
        starred: false,
      });
    });

    await harness.controller.saveCurrent();

    const requestBody = harness.requests[0]?.init?.body;
    expect(typeof requestBody).toBe("string");
    expect(JSON.parse(requestBody as string)).toEqual({ content: "uncached draft" });
    expect(harness.cache.get("draft")?.content).toBe("uncached draft");
    expect(harness.cache.get("draft")?.dirty).toBe(false);
  });

  test("reports non-404 note pull failures instead of claiming a successful sync", async () => {
    const harness = makeHarness();
    harness.setApiHandler(async (input) => {
      if (requestUrl(input) === "/client-api/notes") {
        return jsonResponse([
          {
            key: "remote",
            title: "remote",
            collection: "",
            updatedAt: UPDATED_AT,
            starred: false,
          },
        ]);
      }
      throw new Error("network failed");
    });

    await harness.controller.syncWithServer();

    expect(harness.failures).toHaveLength(1);
    expect(harness.cache.has("remote")).toBe(false);
  });

  test("does not overwrite an edit made while a remote note is being fetched", async () => {
    const local: CachedNote = {
      key: "remote",
      title: "remote",
      collection: "",
      content: "old",
      updatedAt: "2026-07-17T09:00:00.000Z",
      dirty: false,
      existsOnServer: true,
    };
    const harness = makeHarness([local]);
    harness.setApiHandler(async (input) => {
      if (requestUrl(input) === "/client-api/notes") {
        return jsonResponse([{ ...local, updatedAt: UPDATED_AT }]);
      }

      harness.cache.set("remote", {
        ...local,
        content: "local edit",
        updatedAt: "2026-07-17T10:01:00.000Z",
        dirty: true,
      });
      return jsonResponse({ ...local, content: "server edit", updatedAt: UPDATED_AT });
    });

    await harness.controller.syncWithServer();

    expect(harness.cache.get("remote")?.content).toBe("local edit");
    expect(harness.cache.get("remote")?.dirty).toBe(true);
  });

  test("continues a rename chain when the note is renamed again in flight", async () => {
    const target: CachedNote = {
      key: "b",
      title: "b",
      collection: "",
      content: "content",
      updatedAt: UPDATED_AT,
      dirty: false,
      existsOnServer: true,
    };
    const harness = makeHarness([target], [{ type: "rename", oldKey: "a", newKey: "b" }]);
    const renameRequests: string[] = [];

    harness.setApiHandler(async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/a/rename")) {
        renameRequests.push(url);
        harness.cache.delete("b");
        harness.cache.set("c", { ...target, key: "c", title: "c" });
        harness.pendingOps.value = [{ type: "rename", oldKey: "a", newKey: "c" }];
        return jsonResponse({ ...target, key: "b", title: "b" });
      }
      if (url.endsWith("/b/rename")) {
        renameRequests.push(url);
        return jsonResponse({ ...target, key: "c", title: "c" });
      }
      if (url === "/client-api/notes") {
        return jsonResponse([{ ...target, key: "c", title: "c" }]);
      }
      throw new Error(`unexpected request: ${url}`);
    });

    await harness.controller.syncWithServer();

    expect(renameRequests).toEqual(["/client-api/notes/a/rename", "/client-api/notes/b/rename"]);
    expect(harness.pendingOps.value).toEqual([]);
    expect(harness.cache.has("b")).toBe(false);
    expect(harness.cache.get("c")?.existsOnServer).toBe(true);
  });

  test("marks a missing rename target dirty so it can be created", async () => {
    const target: CachedNote = {
      key: "new",
      title: "new",
      collection: "",
      content: "content",
      updatedAt: UPDATED_AT,
      dirty: false,
      existsOnServer: true,
    };
    const harness = makeHarness([target], [{ type: "rename", oldKey: "old", newKey: "new" }]);
    let renameFailed = false;
    harness.setApiHandler(async (input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/rename")) {
        renameFailed = true;
        throw new ApiError(404, "not found");
      }
      if (url === "/client-api/notes" && init?.method === "POST") {
        return jsonResponse({ ...target, updatedAt: UPDATED_AT }, 201);
      }
      if (url === "/client-api/notes") return jsonResponse([{ ...target }]);
      throw new Error(`unexpected request: ${url}`);
    });

    await harness.controller.syncWithServer();

    expect(renameFailed).toBe(true);
    expect(harness.pendingOps.value).toEqual([]);
    expect(harness.cache.get("new")?.existsOnServer).toBe(true);
    expect(harness.cache.get("new")?.dirty).toBe(false);
  });
});
