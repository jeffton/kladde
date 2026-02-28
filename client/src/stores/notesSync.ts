import type { Ref } from 'vue'
import type { CachedNote, NoteMeta, NoteResponse, PendingOp, RenameResponse } from '../types'
import { t } from '../i18n'
import { normalizeCollection, normalizeTs, splitNoteKey } from './notesModel'
import { notePathApi, renameNotePathApi, starNotePathApi } from './notesApi'

interface NotesSyncDeps {
  pendingOps: Ref<PendingOp[]>
  selectedKey: Ref<string>
  currentContent: Ref<string>
  currentUpdatedAt: Ref<string | null>
  dirty: Ref<boolean>
  notes: Ref<NoteMeta[]>
  online: Ref<boolean>
  syncing: Ref<boolean>
  getCachedNote: (key: string) => Promise<CachedNote | undefined>
  getAllCachedNotes: () => Promise<CachedNote[]>
  putCachedNote: (note: CachedNote) => Promise<IDBValidKey>
  deleteCachedNote: (key: string) => Promise<void>
  replacePendingOps: (ops: PendingOp[]) => Promise<void>
  queueWrite: (task: () => Promise<unknown>) => Promise<unknown>
  flushPendingWrites: () => Promise<void>
  refreshStateFromCache: () => Promise<void>
  isActiveNoteLocallyDirty: (key: string) => boolean
  isServerBacked: (note?: CachedNote | null) => boolean
  samePendingOp: (a: PendingOp, b: PendingOp) => boolean
  retargetPendingKey: (ops: PendingOp[], fromKey: string, toKey: string) => PendingOp[]
  normalizeTs: (value?: string | null) => string
  newerTs: (a?: string | null, b?: string | null) => string
  tsMs: (value?: string | null) => number
  apiFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  isNotFoundError: (err: unknown) => boolean
  resetWsFailuresAndReconnect: () => void
  updateSyncStatus: () => void
  clearSyncRetry: () => void
  clearSyncError: () => void
  handleSyncFailure: (err: unknown, fallback: string) => void
}

interface ServerNoteMeta {
  key: string
  title: string
  collection?: string
  updatedAt: string
  starred?: boolean
}

function normalizeServerNote(note: NoteResponse): CachedNote {
  const collection = normalizeCollection(note.collection)
  const title = note.title.trim()

  return {
    key: note.key.trim(),
    title,
    collection,
    content: note.content,
    updatedAt: normalizeTs(note.updatedAt),
    dirty: false,
    starred: Boolean(note.starred),
    existsOnServer: true
  }
}

function normalizeServerMeta(meta: ServerNoteMeta): NoteMeta {
  const collection = normalizeCollection(meta.collection)
  const title = meta.title.trim()

  return {
    key: meta.key.trim(),
    title,
    collection,
    updatedAt: normalizeTs(meta.updatedAt),
    dirty: false,
    starred: Boolean(meta.starred)
  }
}

export function createNotesSync(deps: NotesSyncDeps) {
  let syncInFlight: Promise<void> | null = null
  let pushInFlight: Promise<void> | null = null
  let saveInFlight: Promise<void> | null = null

  const mutatePendingOps = async (mutator: (ops: PendingOp[]) => PendingOp[]) => {
    await deps.queueWrite(async () => {
      const nextOps = mutator([...deps.pendingOps.value])
      deps.pendingOps.value = nextOps
      await deps.replacePendingOps(nextOps)
    })
  }

  const removePendingOp = async (op: PendingOp) => {
    await mutatePendingOps((ops) => {
      const idx = ops.findIndex((candidate) => deps.samePendingOp(candidate, op))
      if (idx === -1) return ops
      const next = [...ops]
      next.splice(idx, 1)
      return next
    })
  }

  const pushDirtyNote = async (key: string) => {
    const local = await deps.getCachedNote(key)
    if (!local || !local.dirty) return

    const localTitle = local.title || splitNoteKey(local.key).title
    const localCollection = local.collection || splitNoteKey(local.key).collection

    let res: Response

    if (local.existsOnServer === false) {
      res = await deps.apiFetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: localTitle, collection: localCollection, content: local.content })
      })
    } else {
      try {
        res = await deps.apiFetch(notePathApi(localTitle, localCollection), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: local.content })
        })
      } catch (err: unknown) {
        if (!deps.isNotFoundError(err)) throw err

        // Note doesn't exist on server — create it instead of discarding.
        res = await deps.apiFetch('/api/notes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: localTitle, collection: localCollection, content: local.content })
        })
      }
    }

    const saved = normalizeServerNote((await res.json()) as NoteResponse)
    deps.resetWsFailuresAndReconnect()

    const originalKey = local.key
    const savedKey = saved.key
    const current = await deps.getCachedNote(originalKey)
    const isActiveOriginal = deps.selectedKey.value === originalKey
    const activeMemoryDiffers = isActiveOriginal && deps.currentContent.value !== saved.content
    const currentContentSnapshot = current?.content ?? local.content

    const stillDirty = activeMemoryDiffers || currentContentSnapshot !== saved.content
    const chosenContent = stillDirty
      ? (activeMemoryDiffers ? deps.currentContent.value : currentContentSnapshot)
      : saved.content
    const chosenUpdatedAt = stillDirty
      ? deps.normalizeTs(current?.updatedAt ?? local.updatedAt)
      : deps.newerTs(current?.updatedAt ?? local.updatedAt, saved.updatedAt ?? local.updatedAt)

    await deps.queueWrite(async () => {
      if (savedKey !== originalKey) {
        await deps.deleteCachedNote(originalKey)
      }

      await deps.putCachedNote({
        ...saved,
        content: chosenContent,
        updatedAt: chosenUpdatedAt,
        dirty: stillDirty,
        starred: Boolean(saved.starred)
      })
    })

    if (isActiveOriginal) {
      deps.selectedKey.value = savedKey
      deps.currentUpdatedAt.value = chosenUpdatedAt
      deps.dirty.value = stillDirty
    }

    const selectedMeta = deps.notes.value.find((n) => n.key === savedKey || n.key === originalKey)
    if (selectedMeta) {
      selectedMeta.key = savedKey
      selectedMeta.title = saved.title
      selectedMeta.collection = saved.collection
      selectedMeta.updatedAt = chosenUpdatedAt
      selectedMeta.dirty = stillDirty
      selectedMeta.starred = Boolean(saved.starred)
    }

    if (savedKey !== originalKey) {
      await mutatePendingOps((ops) => deps.retargetPendingKey(ops, originalKey, savedKey))
    }
  }

  const runPushDirtyNote = async (key: string) => {
    if (pushInFlight) await pushInFlight

    const task = pushDirtyNote(key)
    pushInFlight = task

    try {
      await task
    } finally {
      if (pushInFlight === task) pushInFlight = null
    }
  }

  const processPendingOps = async () => {
    while (deps.pendingOps.value.length > 0) {
      const op = deps.pendingOps.value[0]

      if (op.type === 'delete') {
        const { title, collection } = splitNoteKey(op.key)
        try {
          await deps.apiFetch(notePathApi(title, collection), { method: 'DELETE' })
        } catch (err: unknown) {
          if (!deps.isNotFoundError(err)) throw err
        }
        deps.resetWsFailuresAndReconnect()
        await removePendingOp(op)
        continue
      }

      if (op.type === 'star') {
        const { title, collection } = splitNoteKey(op.key)
        await deps.apiFetch(starNotePathApi(title, collection), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ starred: op.starred })
        })
        deps.resetWsFailuresAndReconnect()
        await removePendingOp(op)
        continue
      }

      const oldRef = splitNoteKey(op.oldKey)
      const newRef = splitNoteKey(op.newKey)

      let res: Response
      try {
        res = await deps.apiFetch(renameNotePathApi(oldRef.title, oldRef.collection), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newTitle: newRef.title, newCollection: newRef.collection })
        })
      } catch (err: unknown) {
        if (!deps.isNotFoundError(err)) throw err

        const localMissingRename = await deps.getCachedNote(op.newKey)
        if (localMissingRename) {
          await deps.queueWrite(async () => {
            await deps.putCachedNote({ ...localMissingRename, existsOnServer: false })
          })
        }

        await removePendingOp(op)
        continue
      }
      deps.resetWsFailuresAndReconnect()

      const payload = normalizeServerNote((await res.json()) as RenameResponse)
      const serverKey = payload.key

      const renamedLocal = await deps.getCachedNote(op.newKey)
      if (renamedLocal) {
        if (serverKey !== op.newKey) {
          await deps.queueWrite(async () => {
            await deps.deleteCachedNote(op.newKey)
            await deps.putCachedNote({
              ...renamedLocal,
              key: serverKey,
              title: payload.title,
              collection: payload.collection,
              existsOnServer: true,
              dirty: Boolean(renamedLocal.dirty)
            })
          })
          if (deps.selectedKey.value === op.newKey) {
            deps.selectedKey.value = serverKey
          }
        } else {
          await deps.queueWrite(async () => {
            await deps.putCachedNote({
              ...renamedLocal,
              title: payload.title,
              collection: payload.collection,
              existsOnServer: true
            })
          })
        }
      }

      await mutatePendingOps((ops) => {
        const idx = ops.findIndex((candidate) => deps.samePendingOp(candidate, op))
        if (idx === -1) return ops

        const next = [...ops]
        next.splice(idx, 1)

        if (serverKey !== op.newKey) {
          return deps.retargetPendingKey(next, op.newKey, serverKey)
        }

        return next
      })
    }
  }

  const saveCurrent = async () => {
    if (!deps.selectedKey.value) return
    if (saveInFlight) return saveInFlight

    const keyAtStart = deps.selectedKey.value

    saveInFlight = (async () => {
      await deps.flushPendingWrites()
      const existing = await deps.getCachedNote(keyAtStart)
      const { title, collection } = existing || splitNoteKey(keyAtStart)

      await deps.putCachedNote({
        key: keyAtStart,
        title,
        collection,
        content: deps.currentContent.value,
        updatedAt: deps.currentUpdatedAt.value || new Date().toISOString(),
        dirty: true,
        starred: existing?.starred,
        existsOnServer: existing?.existsOnServer
      })

      if (!deps.online.value) {
        deps.updateSyncStatus()
        return
      }

      deps.syncing.value = true
      deps.updateSyncStatus()
      try {
        await runPushDirtyNote(keyAtStart)
        deps.clearSyncError()
      } catch (err: unknown) {
        deps.handleSyncFailure(err, t('couldNotSaveNote'))
        throw err
      } finally {
        deps.syncing.value = false
        deps.updateSyncStatus()
      }
    })()

    try {
      await saveInFlight
    } finally {
      saveInFlight = null
    }
  }

  const syncWithServer = async () => {
    if (syncInFlight) return syncInFlight

    syncInFlight = (async () => {
      if (!deps.online.value) {
        deps.updateSyncStatus()
        return
      }

      await deps.flushPendingWrites()
      deps.syncing.value = true
      deps.updateSyncStatus()

      try {
        await processPendingOps()

        const localNotes = await deps.getAllCachedNotes()
        for (const local of localNotes) {
          if (!local.dirty) continue
          await runPushDirtyNote(local.key)
        }

        const metaRes = await deps.apiFetch('/api/notes')
        const serverMetas = ((await metaRes.json()) as ServerNoteMeta[]).map(normalizeServerMeta)
        const currentLocalMap = new Map((await deps.getAllCachedNotes()).map((n) => [n.key, n]))
        const serverKeys = new Set(serverMetas.map((n) => n.key))

        for (const local of currentLocalMap.values()) {
          if (local.dirty || !deps.isServerBacked(local) || serverKeys.has(local.key)) continue

          await deps.deleteCachedNote(local.key)

          if (deps.selectedKey.value === local.key) {
            deps.selectedKey.value = ''
            deps.currentContent.value = ''
            deps.currentUpdatedAt.value = null
            deps.dirty.value = false
          }
        }

        for (const serverMeta of serverMetas) {
          const local = currentLocalMap.get(serverMeta.key)
          const serverTs = deps.tsMs(serverMeta.updatedAt)
          const localTs = local ? deps.tsMs(local.updatedAt) : 0
          const isActiveAndDirty = deps.isActiveNoteLocallyDirty(serverMeta.key)
          const shouldPull = !isActiveAndDirty && (!local || (!local.dirty && serverTs > localTs))

          if (local && local.starred !== serverMeta.starred) {
            await deps.putCachedNote({ ...local, starred: Boolean(serverMeta.starred), existsOnServer: true })
          }

          if (!shouldPull) continue

          let noteRes: Response
          try {
            noteRes = await deps.apiFetch(notePathApi(serverMeta.title, serverMeta.collection))
          } catch {
            continue
          }
          const serverNote = normalizeServerNote((await noteRes.json()) as NoteResponse)
          await deps.putCachedNote({
            ...serverNote,
            updatedAt: deps.normalizeTs(serverNote.updatedAt || serverMeta.updatedAt),
            dirty: false,
            starred: Boolean(serverNote.starred ?? serverMeta.starred),
            existsOnServer: true
          })
        }

        await deps.refreshStateFromCache()
        deps.clearSyncRetry()
        deps.clearSyncError()
      } catch (err: unknown) {
        deps.handleSyncFailure(err, t('couldNotSync'))
      } finally {
        deps.syncing.value = false
        deps.updateSyncStatus()
      }
    })()

    try {
      await syncInFlight
    } finally {
      syncInFlight = null
    }
  }

  return {
    mutatePendingOps,
    saveCurrent,
    syncWithServer
  }
}
