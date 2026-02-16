import { openDB } from 'idb'

const DB_NAME = 'noteapp-db'
const DB_VERSION = 1
const NOTES_STORE = 'notes'

let dbPromise

function db() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains(NOTES_STORE)) {
          database.createObjectStore(NOTES_STORE, { keyPath: 'title' })
        }
      }
    })
  }
  return dbPromise
}

export async function getAllCachedNotes() {
  return (await db()).getAll(NOTES_STORE)
}

export async function getCachedNote(title) {
  return (await db()).get(NOTES_STORE, title)
}

export async function putCachedNote(note) {
  return (await db()).put(NOTES_STORE, note)
}

export async function putCachedNotes(notes) {
  const database = await db()
  const tx = database.transaction(NOTES_STORE, 'readwrite')
  for (const note of notes) {
    tx.store.put(note)
  }
  await tx.done
}
