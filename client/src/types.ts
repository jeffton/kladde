export interface NoteMeta {
  key: string
  title: string
  collection: string
  updatedAt: string
  dirty: boolean
  starred?: boolean
}

export interface CachedNote extends NoteMeta {
  content: string
  version?: number
  // false means local-only note not yet confirmed on server
  existsOnServer?: boolean
}

export type PendingOp =
  | { type: 'rename'; oldKey: string; newKey: string }
  | { type: 'delete'; key: string }
  | { type: 'star'; key: string; starred: boolean }

export type StoredPendingOp = PendingOp & { id: number }

export interface NoteResponse {
  key: string
  title: string
  collection?: string
  content: string
  updatedAt: string
  starred?: boolean
}

export interface RenameResponse extends NoteResponse {
  error?: string
}

export interface AuthUser {
  username: string
  displayName: string
}

export type SyncState = 'offline' | 'syncing' | 'error' | 'synced'

export interface NotesState {
  notes: NoteMeta[]
  selectedKey: string
  currentContent: string
  currentUpdatedAt: string | null
  pinned: Set<string>
  dirty: boolean
  online: boolean
  syncStatus: string
  syncState: SyncState
  syncing: boolean
  syncError: string
  contentVersion: number
  noteContents: Record<string, string>
}
