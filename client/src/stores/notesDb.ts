import { openDB } from 'idb'
import type { CachedNote, PendingOp, StoredPendingOp } from '../types'

const DB_NAME = 'kladde-db'
const DB_VERSION = 2
const NOTES_STORE = 'notes'
const OPS_STORE = 'ops'

interface NoteAppDb {
  notes: {
    key: string
    value: CachedNote
  }
  ops: {
    key: number
    value: StoredPendingOp
  }
}

let dbPromise: ReturnType<typeof openDB<NoteAppDb>> | null = null

function db() {
  if (!dbPromise) {
    dbPromise = openDB<NoteAppDb>(DB_NAME, DB_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains(NOTES_STORE)) {
          database.createObjectStore(NOTES_STORE, { keyPath: 'title' })
        }
        if (!database.objectStoreNames.contains(OPS_STORE)) {
          database.createObjectStore(OPS_STORE, { keyPath: 'id', autoIncrement: true })
        }
      }
    })
  }

  return dbPromise
}

export async function getAllCachedNotes(): Promise<CachedNote[]> {
  return (await db()).getAll(NOTES_STORE)
}

export async function getCachedNote(title: string): Promise<CachedNote | undefined> {
  return (await db()).get(NOTES_STORE, title)
}

export async function putCachedNote(note: CachedNote): Promise<IDBValidKey> {
  return (await db()).put(NOTES_STORE, note)
}

export async function deleteCachedNote(title: string): Promise<void> {
  await (await db()).delete(NOTES_STORE, title)
}

export async function getPendingOps(): Promise<StoredPendingOp[]> {
  const ops = await (await db()).getAll(OPS_STORE)
  return ops.sort((a, b) => a.id - b.id)
}

export async function replacePendingOps(ops: PendingOp[]): Promise<void> {
  const database = await db()
  const tx = database.transaction(OPS_STORE, 'readwrite')
  await tx.objectStore(OPS_STORE).clear()
  for (const op of ops) {
    await tx.objectStore(OPS_STORE).add(op)
  }
  await tx.done
}
