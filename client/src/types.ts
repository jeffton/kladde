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

export type AppMode = 'full' | 'share-readonly' | 'share-edit'

export interface EditorStoreLike {
  notes: NoteMeta[]
  selectedKey: string
  selectedTitle: string
  selectedCollection: string
  currentContent: string
  currentUpdatedAt: string | null
  syncStatus: string
  syncState: SyncState
  collections: string[]
  noteContents: Record<string, string>
  setCurrentContent: (content: string) => Promise<void>
  renameCurrent: (newTitle: string, collectionOverride?: string) => Promise<string>
  moveCurrentToCollection: (nextCollection: string) => Promise<string>
  deleteCurrent: () => Promise<void>
}

export interface RenameResponse extends NoteResponse {
  error?: string
}

export interface AuthUser {
  username: string
  displayName: string
}

export type ShareMode = 'view' | 'edit'

export interface SharedNoteResponse extends NoteResponse {
  shareMode: ShareMode
}

export interface ShareLink {
  enabled: boolean
  token?: string
  url?: string
}

export interface ShareLinksResponse {
  view: ShareLink
  edit: ShareLink
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
