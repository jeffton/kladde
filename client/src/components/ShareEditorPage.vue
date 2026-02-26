<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Link from '@tiptap/extension-link'
import CodeBlock from '@tiptap/extension-code-block'
import Strike from '@tiptap/extension-strike'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableHeader from '@tiptap/extension-table-header'
import TableCell from '@tiptap/extension-table-cell'
import { Markdown } from 'tiptap-markdown'
import EditorToolbar from './EditorToolbar.vue'
import { apiFetch, clientOrigin, sharedNotePathApi } from '../stores/notesApi'
import { t } from '../i18n'
import type { NoteResponse } from '../types'

const route = useRoute()

const token = computed(() => (typeof route.params.token === 'string' ? route.params.token : ''))
const title = ref('')
const content = ref('')
const noteKey = ref('')
const loading = ref(true)
const error = ref('')
const dirty = ref(false)
const saving = ref(false)
const saveError = ref('')
const pendingRefresh = ref(false)

let ignoreEditorChanges = false
let saveTimer: number | null = null
let ws: WebSocket | null = null
let reconnectTimer: number | null = null
let reconnectAttempt = 0
let destroyed = false

const statusText = computed(() => {
  if (loading.value) return t('loading')
  if (saving.value) return t('syncingShort')
  if (saveError.value) return saveError.value
  if (dirty.value) return t('syncingShort')
  return t('syncedShort')
})

function clearSaveTimer() {
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer)
    saveTimer = null
  }
}

function clearReconnectTimer() {
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function setEditorContent(next = '') {
  if (!editor.value) return
  ignoreEditorChanges = true
  editor.value.commands.setContent(next, false)
  ignoreEditorChanges = false
}

async function fetchSharedNote(force = false) {
  if (!token.value) return
  if (dirty.value && !force) {
    pendingRefresh.value = true
    return
  }

  try {
    const response = await apiFetch(sharedNotePathApi(token.value))
    const note = (await response.json()) as NoteResponse
    title.value = note.title || ''
    noteKey.value = note.key || ''
    content.value = note.content || ''
    setEditorContent(content.value)
    error.value = ''
    saveError.value = ''
    pendingRefresh.value = false
  } catch (err) {
    error.value = (err as Error)?.message || t('genericError')
  } finally {
    loading.value = false
  }
}

async function saveSharedNote() {
  if (!token.value || !dirty.value || saving.value) return

  saving.value = true
  saveError.value = ''

  try {
    const response = await apiFetch(sharedNotePathApi(token.value), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content.value })
    })

    const note = (await response.json()) as NoteResponse
    title.value = note.title || title.value
    noteKey.value = note.key || noteKey.value
    content.value = note.content || ''
    dirty.value = false

    if (pendingRefresh.value) {
      await fetchSharedNote(true)
    }
  } catch (err) {
    saveError.value = (err as Error)?.message || t('couldNotSaveNote')
  } finally {
    saving.value = false
  }
}

function scheduleSave() {
  clearSaveTimer()
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    void saveSharedNote()
  }, 450)
}

function connectWs() {
  if (!token.value || destroyed) return
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsUrl = `${protocol}//${window.location.host}/api/ws?shareToken=${encodeURIComponent(token.value)}`

  try {
    ws = new WebSocket(wsUrl)
  } catch {
    scheduleReconnect()
    return
  }

  ws.onopen = () => {
    reconnectAttempt = 0
    clearReconnectTimer()
  }

  ws.onmessage = (event) => {
    try {
      const payload = JSON.parse(String(event.data)) as {
        type?: string
        key?: string
        origin?: string
      }

      if (payload.type !== 'note_changed') return
      if (payload.origin && payload.origin === clientOrigin) return
      if (noteKey.value && payload.key && payload.key !== noteKey.value) return

      if (dirty.value || saving.value) {
        pendingRefresh.value = true
        return
      }

      void fetchSharedNote()
    } catch {
      // ignore malformed payloads
    }
  }

  ws.onclose = () => {
    ws = null
    if (!destroyed) scheduleReconnect()
  }

  ws.onerror = () => {
    ws?.close()
  }
}

function scheduleReconnect() {
  if (destroyed || reconnectTimer !== null) return

  const delay = Math.min(30000, 1000 * 2 ** reconnectAttempt)
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null
    connectWs()
  }, delay)
  reconnectAttempt = Math.min(reconnectAttempt + 1, 5)
}

const editor = useEditor({
  extensions: [
    StarterKit.configure({ strike: false, codeBlock: false }),
    Strike,
    CodeBlock,
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    Link.configure({
      autolink: true,
      openOnClick: true,
      linkOnPaste: true,
      HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' }
    }),
    Markdown.configure({ html: false, transformCopiedText: true, transformPastedText: true })
  ],
  content: '',
  onUpdate: ({ editor: tiptapEditor }) => {
    if (ignoreEditorChanges) return

    const nextMarkdown = tiptapEditor.storage.markdown.getMarkdown()
    if (nextMarkdown === content.value) return

    content.value = nextMarkdown
    dirty.value = true
    scheduleSave()
  }
})

watch(token, async () => {
  loading.value = true
  error.value = ''
  dirty.value = false
  clearSaveTimer()
  await fetchSharedNote(true)
  connectWs()
})

onMounted(async () => {
  await fetchSharedNote(true)
  connectWs()
})

onUnmounted(() => {
  destroyed = true
  clearSaveTimer()
  clearReconnectTimer()
  ws?.close()
  ws = null
  editor.value?.destroy()
})
</script>

<template>
  <main class="editor-area share-editor-area">
    <div class="share-header">
      <h1 class="share-title">{{ title || 'kladde' }}</h1>
      <div class="share-status">{{ statusText }}</div>
    </div>

    <p v-if="error" class="share-error" role="alert">{{ error }}</p>

    <EditorToolbar :editor="editor || null" :show-mode-toggle="false" />

    <section class="wysiwyg-wrap">
      <EditorContent v-if="editor" :editor="editor || null" class="tiptap-root" />
    </section>
  </main>
</template>
