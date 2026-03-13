import { openDB } from "idb";
import type { CachedNote, PendingOp, StoredPendingOp } from "../types";
import { buildNoteKey, normalizeCollection } from "./notesModel";

const DB_NAME = "kladde-db";
const DB_VERSION = 3;
const NOTES_STORE = "notes";
const OPS_STORE = "ops";
const MAX_IDB_RETRIES = 2;

interface NoteAppDb {
  notes: {
    key: string;
    value: CachedNote;
  };
  ops: {
    key: number;
    value: StoredPendingOp;
  };
}

let dbPromise: ReturnType<typeof openDB<NoteAppDb>> | null = null;

function isRetriableIdbError(err: unknown): boolean {
  if (!err) return false;

  const name = (err as DOMException)?.name || "";
  if (
    name === "UnknownError" ||
    name === "InvalidStateError" ||
    name === "TransactionInactiveError" ||
    name === "AbortError"
  ) {
    return true;
  }

  const message = ((err as Error)?.message || "").toLowerCase();
  return (
    message.includes("without an in-progress transaction") ||
    message.includes("transaction is inactive or finished") ||
    message.includes("connection to indexed database server lost") ||
    message.includes("internal error was encountered in the indexed database server") ||
    message.includes("database connection is closing")
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function closeAndResetDb(): Promise<void> {
  const pending = dbPromise;
  dbPromise = null;
  if (!pending) return;

  try {
    const database = await pending;
    database.close();
  } catch {
    // Ignore failures while recovering the connection.
  }
}

function createDbPromise() {
  return openDB<NoteAppDb>(DB_NAME, DB_VERSION, {
    upgrade(database, oldVersion) {
      if (!database.objectStoreNames.contains(NOTES_STORE)) {
        database.createObjectStore(NOTES_STORE, { keyPath: "key" });
      }
      if (!database.objectStoreNames.contains(OPS_STORE)) {
        database.createObjectStore(OPS_STORE, { keyPath: "id", autoIncrement: true });
      }

      // v3: switch note identity from title -> key and reset incompatible pending ops.
      if (oldVersion < 3) {
        if (database.objectStoreNames.contains(NOTES_STORE)) {
          database.deleteObjectStore(NOTES_STORE);
        }
        database.createObjectStore(NOTES_STORE, { keyPath: "key" });

        if (database.objectStoreNames.contains(OPS_STORE)) {
          database.deleteObjectStore(OPS_STORE);
        }
        database.createObjectStore(OPS_STORE, { keyPath: "id", autoIncrement: true });
      }
    },
    blocking() {
      void closeAndResetDb();
    },
    terminated() {
      dbPromise = null;
    },
  });
}

function db() {
  if (!dbPromise) {
    dbPromise = createDbPromise();
  }

  return dbPromise;
}

async function runWithIdbRetry<T>(operation: () => Promise<T>): Promise<T> {
  let attempt = 0;

  while (true) {
    try {
      return await operation();
    } catch (err) {
      if (!isRetriableIdbError(err) || attempt >= MAX_IDB_RETRIES) {
        throw err;
      }

      attempt += 1;
      await closeAndResetDb();
      await sleep(40 * 2 ** attempt);
    }
  }
}

function normalizeCachedNote(note: CachedNote): CachedNote {
  const normalizedCollection = normalizeCollection(note.collection);
  const normalizedTitle = (note.title || "").trim();
  const normalizedKey =
    (note.key || "").trim() || buildNoteKey(normalizedTitle, normalizedCollection);

  return {
    ...note,
    key: normalizedKey,
    title: normalizedTitle,
    collection: normalizedCollection,
  };
}

export async function getAllCachedNotes(): Promise<CachedNote[]> {
  return runWithIdbRetry(async () => {
    const all = await (await db()).getAll(NOTES_STORE);
    return all.map(normalizeCachedNote);
  });
}

export async function getCachedNote(key: string): Promise<CachedNote | undefined> {
  return runWithIdbRetry(async () => {
    const note = await (await db()).get(NOTES_STORE, key);
    if (!note) return undefined;
    return normalizeCachedNote(note);
  });
}

export async function putCachedNote(note: CachedNote): Promise<IDBValidKey> {
  const normalized = normalizeCachedNote(note);
  return runWithIdbRetry(async () => (await db()).put(NOTES_STORE, normalized));
}

export async function deleteCachedNote(key: string): Promise<void> {
  await runWithIdbRetry(async () => (await db()).delete(NOTES_STORE, key));
}

export async function getPendingOps(): Promise<StoredPendingOp[]> {
  const ops = await runWithIdbRetry(async () => (await db()).getAll(OPS_STORE));
  return ops.sort((a, b) => a.id - b.id);
}

export async function replacePendingOps(ops: PendingOp[]): Promise<void> {
  await runWithIdbRetry(async () => {
    const database = await db();
    const tx = database.transaction(OPS_STORE, "readwrite");
    await tx.objectStore(OPS_STORE).clear();
    for (const op of ops) {
      await tx.objectStore(OPS_STORE).add(op);
    }
    await tx.done;
  });
}
