import type { Ref } from 'vue'
import type { CachedNote, NoteMeta, NoteResponse, PendingOp, RenameResponse } from '../types'
import { t } from '../i18n'

interface NotesSyncDeps {
  pendingOps: Ref<PendingOp[]>
  selectedTitle: Ref<string>
  currentContent: Ref<string>
  currentUpdatedAt: Ref<string | null>
  dirty: Ref<boolean>
  notes: Ref<NoteMeta[]>
  online: Ref<boolean>
  syncing: Ref<boolean>
  getCachedNote: (title: string) => Promise<CachedNote | undefined>
  getAllCachedNotes: () => Promise<CachedNote[]>
  putCachedNote: (note: CachedNote) => Promise<IDBValidKey>
  deleteCachedNote: (title: string) => Promise<void>
  replacePendingOps: (ops: PendingOp[]) => Promise<void>
  queueWrite: (task: () => Promise<unknown>) => Promise<unknown>
  flushPendingWrites: () => Promise<void>
  refreshStateFromCache: () => Promise<void>
  isActiveNoteLocallyDirty: (title: string) => boolean
  isServerBacked: (note?: CachedNote | null) => boolean
  samePendingOp: (a: PendingOp, b: PendingOp) => boolean
  retargetPendingTitle: (ops: PendingOp[], fromTitle: string, toTitle: string) => PendingOp[]
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

  const pushDirtyNote = async (title: string) => {
    const local = await deps.getCachedNote(title)
    if (!local || !local.dirty) return

    let res: Response
    try {
      res = await deps.apiFetch(`/api/notes/${encodeURIComponent(title)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: local.content })
      })
    } catch (err: unknown) {
      if (!deps.isNotFoundError(err)) throw err

      // Note doesn't exist on server — create it instead of discarding
      res = await deps.apiFetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, content: local.content })
      })
    }

    const saved = (await res.json()) as NoteResponse
    deps.resetWsFailuresAndReconnect()

    // Dirty until server has saved the exact content we currently hold locally.
    const current = await deps.getCachedNote(title)
    const activeMemoryDiffers = deps.selectedTitle.value === title && deps.currentContent.value !== saved.content
    const currentContentSnapshot = current?.content ?? local.content
    const stillDirty = activeMemoryDiffers || currentContentSnapshot !== saved.content
    const chosenContent = stillDirty
      ? (activeMemoryDiffers ? deps.currentContent.value : currentContentSnapshot)
      : saved.content
    const chosenUpdatedAt = stillDirty
      ? deps.normalizeTs(current?.updatedAt ?? local.updatedAt)
      : deps.newerTs(current?.updatedAt ?? local.updatedAt, saved.updatedAt ?? local.updatedAt)

    await deps.putCachedNote({
      title: saved.title,
      content: chosenContent,
      updatedAt: chosenUpdatedAt,
      dirty: stillDirty,
      starred: Boolean(saved.starred),
      existsOnServer: true
    })

    if (deps.selectedTitle.value === title) {
      deps.currentUpdatedAt.value = chosenUpdatedAt
      deps.dirty.value = stillDirty

      const selectedMeta = deps.notes.value.find((n) => n.title === title)
      if (selectedMeta) {
        selectedMeta.updatedAt = chosenUpdatedAt
        selectedMeta.dirty = stillDirty
      }
    }
  }

  const runPushDirtyNote = async (title: string) => {
    if (pushInFlight) await pushInFlight

    const task = pushDirtyNote(title)
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
        try {
          await deps.apiFetch(`/api/notes/${encodeURIComponent(op.title)}`, { method: 'DELETE' })
        } catch (err: unknown) {
          if (!deps.isNotFoundError(err)) throw err
        }
        deps.resetWsFailuresAndReconnect()
        await removePendingOp(op)
        continue
      }

      if (op.type === 'star') {
        await deps.apiFetch(`/api/notes/${encodeURIComponent(op.title)}/star`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ starred: op.starred })
        })
        deps.resetWsFailuresAndReconnect()
        await removePendingOp(op)
        continue
      }

      let res: Response
      try {
        res = await deps.apiFetch(`/api/notes/${encodeURIComponent(op.oldTitle)}/rename`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newTitle: op.newTitle })
        })
      } catch (err: unknown) {
        if (!deps.isNotFoundError(err)) throw err

        const localMissingRename = await deps.getCachedNote(op.newTitle)
        if (localMissingRename) {
          await deps.queueWrite(async () => {
            await deps.putCachedNote({ ...localMissingRename, existsOnServer: false })
          })
        }

        await removePendingOp(op)
        continue
      }
      deps.resetWsFailuresAndReconnect()

      const payload = (await res.json()) as RenameResponse
      const serverTitle = payload?.title?.trim()
      if (!serverTitle) throw new Error(t('invalidServerTitle'))

      const renamedLocal = await deps.getCachedNote(op.newTitle)
      if (renamedLocal) {
        if (serverTitle !== op.newTitle) {
          await deps.queueWrite(async () => {
            await deps.deleteCachedNote(op.newTitle)
            await deps.putCachedNote({
              ...renamedLocal,
              title: serverTitle,
              existsOnServer: true,
              dirty: Boolean(renamedLocal.dirty)
            })
          })
          if (deps.selectedTitle.value === op.newTitle) {
            deps.selectedTitle.value = serverTitle
          }
        } else {
          await deps.queueWrite(async () => {
            await deps.putCachedNote({ ...renamedLocal, existsOnServer: true })
          })
        }
      }

      await mutatePendingOps((ops) => {
        const idx = ops.findIndex((candidate) => deps.samePendingOp(candidate, op))
        if (idx === -1) return ops

        const next = [...ops]
        next.splice(idx, 1)

        if (serverTitle !== op.newTitle) {
          return deps.retargetPendingTitle(next, op.newTitle, serverTitle)
        }

        return next
      })
    }
  }

  const saveCurrent = async () => {
    if (!deps.selectedTitle.value) return
    if (saveInFlight) return saveInFlight

    const titleAtStart = deps.selectedTitle.value

    saveInFlight = (async () => {
      await deps.flushPendingWrites()
      const existing = await deps.getCachedNote(titleAtStart)
      await deps.putCachedNote({
        title: titleAtStart,
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
        await runPushDirtyNote(titleAtStart)
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
          await runPushDirtyNote(local.title)
        }

        const metaRes = await deps.apiFetch('/api/notes')
        const serverMetas = (await metaRes.json()) as NoteMeta[]
        const currentLocalMap = new Map((await deps.getAllCachedNotes()).map((n) => [n.title, n]))
        const serverTitles = new Set(serverMetas.map((n) => n.title))

        for (const local of currentLocalMap.values()) {
          if (local.dirty || !deps.isServerBacked(local) || serverTitles.has(local.title)) continue

          await deps.deleteCachedNote(local.title)

          if (deps.selectedTitle.value === local.title) {
            deps.selectedTitle.value = ''
            deps.currentContent.value = ''
            deps.currentUpdatedAt.value = null
            deps.dirty.value = false
          }
        }

        for (const serverMeta of serverMetas) {
          const local = currentLocalMap.get(serverMeta.title)
          const serverTs = deps.tsMs(serverMeta.updatedAt)
          const localTs = local ? deps.tsMs(local.updatedAt) : 0
          const isActiveAndDirty = deps.isActiveNoteLocallyDirty(serverMeta.title)
          const shouldPull = !isActiveAndDirty && (!local || (!local.dirty && serverTs > localTs))

          if (local && local.starred !== serverMeta.starred) {
            await deps.putCachedNote({ ...local, starred: Boolean(serverMeta.starred), existsOnServer: true })
          }

          if (!shouldPull) continue

          let noteRes: Response
          try {
            noteRes = await deps.apiFetch(`/api/notes/${encodeURIComponent(serverMeta.title)}`)
          } catch {
            continue
          }
          const serverNote = (await noteRes.json()) as NoteResponse
          await deps.putCachedNote({
            title: serverNote.title,
            content: serverNote.content,
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
        throw err
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
