import { openDB } from 'idb'
import type { CachedNote } from '../types'

const DB_NAME = 'noteapp-db'
const DB_VERSION = 1
const NOTES_STORE = 'notes'

interface NoteAppDb {
  notes: {
    key: string
    value: CachedNote
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
