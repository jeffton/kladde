export interface NoteMeta {
  title: string
  updatedAt: string
  dirty: boolean
  starred?: boolean
}

export interface CachedNote extends NoteMeta {
  content: string
  starred?: boolean
  version?: number
}

export interface NoteResponse {
  title: string
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

export interface NotesState {
  notes: NoteMeta[]
  selectedTitle: string
  currentContent: string
  currentUpdatedAt: string | null
  pinned: Set<string>
  dirty: boolean
  online: boolean
  syncStatus: string
  syncing: boolean
  syncError: string
  contentVersion: number
  noteContents: Record<string, string>
}
