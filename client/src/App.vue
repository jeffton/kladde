<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Link from '@tiptap/extension-link'
import CodeBlock from '@tiptap/extension-code-block'
import Placeholder from '@tiptap/extension-placeholder'
import Strike from '@tiptap/extension-strike'
import { Markdown } from 'tiptap-markdown'
import { useNotesStore } from './stores/notes'

const store = useNotesStore()
const showPlain = ref(false)
const newTitle = ref('')
const error = ref('')
const isMobile = ref(window.matchMedia('(max-width: 900px)').matches)
const mobileView = ref('editor') // 'list' | 'editor'
let ignoreEditorChanges = false
let autosaveTimer = null
let syncTimer = null
let suppressHistoryPush = false
let media = null
let mediaListener = null
let popStateHandler = null

const online = () => store.setOnline(true)
const offline = () => store.setOnline(false)

const editor = useEditor({
  extensions: [
    StarterKit.configure({
      strike: false,
      codeBlock: false,
    }),
    Strike,
    CodeBlock,
    TaskList,
    TaskItem.configure({ nested: true }),
    Link.configure({
      autolink: true,
      openOnClick: true,
      linkOnPaste: true,
      HTMLAttributes: {
        rel: 'noopener noreferrer nofollow',
        target: '_blank',
      },
    }),
    Placeholder.configure({ placeholder: 'Skriv din note her…' }),
    Markdown.configure({
      html: false,
      transformCopiedText: true,
      transformPastedText: true,
    }),
  ],
  content: store.currentContent || '',
  contentType: 'markdown',
  onUpdate: ({ editor: tiptapEditor }) => {
    if (ignoreEditorChanges) return
    const markdown = tiptapEditor.storage.markdown.getMarkdown()
    if (markdown !== store.currentContent) store.setCurrentContent(markdown)
  },
})

const sortedNotes = computed(() => store.sortedNotes)
const appShellClasses = computed(() => ({
  'mobile-list-view': isMobile.value && mobileView.value === 'list',
  'mobile-editor-view': isMobile.value && mobileView.value === 'editor',
}))

const saveLabel = computed(() => (store.dirty ? 'Ikke gemt' : 'Gemt'))

function currentPathForState() {
  if (isMobile.value && mobileView.value === 'list') return '/'
  if (!store.selectedTitle) return '/'
  return `/note/${encodeURIComponent(store.selectedTitle)}`
}

function pushCurrentHistory() {
  if (suppressHistoryPush) return
  const nextPath = currentPathForState()
  if (window.location.pathname !== nextPath) {
    history.pushState({ title: store.selectedTitle, view: mobileView.value }, '', nextPath)
  }
}

function setEditorMarkdown(markdown = '') {
  if (!editor.value) return
  ignoreEditorChanges = true
  editor.value.commands.setContent(markdown || '', false, { contentType: 'markdown' })
  ignoreEditorChanges = false
}

function syncEditorFromStore() {
  if (!editor.value || showPlain.value) return
  const current = editor.value.storage.markdown.getMarkdown()
  if (current === store.currentContent) return
  setEditorMarkdown(store.currentContent)
}

function applyLink() {
  if (!editor.value) return
  const previousUrl = editor.value.getAttributes('link').href
  const href = window.prompt('Indsæt link (https://...)', previousUrl || '')

  if (href === null) return
  if (href === '') {
    editor.value.chain().focus().unsetLink().run()
    return
  }

  editor.value.chain().focus().setLink({ href }).run()
}

async function load() {
  try {
    await store.initialize()
    await applyRouteFromLocation(true)
    syncEditorFromStore()
  } catch (e) {
    error.value = e.message
  }
}

async function selectNote(title, fromRoute = false) {
  try {
    await store.selectNote(title)
    if (isMobile.value) mobileView.value = 'editor'
    syncEditorFromStore()
    error.value = ''
    if (!fromRoute) pushCurrentHistory()
  } catch (e) {
    error.value = e.message
  }
}

async function createNote() {
  if (!newTitle.value.trim()) return
  try {
    await store.createNote(newTitle.value.trim())
    newTitle.value = ''
    if (isMobile.value) mobileView.value = 'editor'
    syncEditorFromStore()
    error.value = ''
    pushCurrentHistory()
  } catch (e) {
    error.value = e.message
  }
}

function goBackToList() {
  mobileView.value = 'list'
  pushCurrentHistory()
}

function togglePin(title) {
  store.togglePin(title)
}

async function applyRouteFromLocation(replace = false) {
  const path = window.location.pathname

  if (path.startsWith('/note/')) {
    const title = decodeURIComponent(path.replace('/note/', ''))
    if (title) {
      suppressHistoryPush = true
      try {
        await selectNote(title, true)
      } finally {
        suppressHistoryPush = false
      }
      mobileView.value = 'editor'
      if (replace) history.replaceState({ title, view: 'editor' }, '', window.location.pathname)
      return
    }
  }

  if (isMobile.value) {
    mobileView.value = 'list'
  } else {
    mobileView.value = 'editor'
  }

  if (replace) history.replaceState({ title: store.selectedTitle, view: mobileView.value }, '', '/')
}

watch(showPlain, (isPlain) => {
  if (isPlain) {
    if (editor.value) {
      const markdown = editor.value.storage.markdown.getMarkdown()
      if (markdown !== store.currentContent) store.setCurrentContent(markdown)
    }
    return
  }

  syncEditorFromStore()
})

watch(
  () => store.currentContent,
  () => {
    syncEditorFromStore()
  }
)

onMounted(async () => {
  await load()

  media = window.matchMedia('(max-width: 900px)')
  mediaListener = (event) => {
    isMobile.value = event.matches
    if (event.matches && !store.selectedTitle) mobileView.value = 'list'
    if (!event.matches) mobileView.value = 'editor'
  }

  media.addEventListener('change', mediaListener)

  popStateHandler = async () => {
    await applyRouteFromLocation()
  }

  window.addEventListener('popstate', popStateHandler)
  window.addEventListener('online', online)
  window.addEventListener('offline', offline)

  autosaveTimer = setInterval(async () => {
    if (!store.dirty) return
    try {
      await store.saveCurrent()
      error.value = ''
    } catch {
      // keep quiet, status already indicates failure
    }
  }, 2500)

  syncTimer = setInterval(async () => {
    if (!store.online) return
    try {
      await store.syncWithServer()
      if (!showPlain.value && !store.dirty) syncEditorFromStore()
      error.value = ''
    } catch {
      // ignore transient sync errors
    }
  }, 15000)
})

onUnmounted(() => {
  if (media && mediaListener) media.removeEventListener('change', mediaListener)
  if (popStateHandler) window.removeEventListener('popstate', popStateHandler)
  window.removeEventListener('online', online)
  window.removeEventListener('offline', offline)
  clearInterval(autosaveTimer)
  clearInterval(syncTimer)
})
</script>

<template>
  <div class="app-shell" :class="appShellClasses">
    <aside class="sidebar">
      <h1>Noteapp</h1>
      <div class="create-row">
        <input v-model="newTitle" placeholder="Ny note titel" @keyup.enter="createNote" />
        <button @click="createNote">Opret</button>
      </div>

      <div class="list">
        <button
          v-for="note in sortedNotes"
          :key="note.title"
          class="note-item"
          :class="{ active: note.title === store.selectedTitle }"
          @click="selectNote(note.title)">
          <div>
            <strong>{{ note.title }}</strong>
            <small>{{ new Date(note.updatedAt).toLocaleString() }}</small>
          </div>
          <span class="pin" @click.stop="togglePin(note.title)">{{ store.pinned.has(note.title) ? '📌' : '📍' }}</span>
        </button>
      </div>
    </aside>

    <main class="editor-area">
      <header class="toolbar">
        <div class="toolbar-left">
          <button v-if="isMobile && mobileView === 'editor'" class="back-button" @click="goBackToList">← Tilbage</button>
          <div class="status">
            <span :class="store.online ? 'online' : 'offline'">{{ store.online ? 'Online' : 'Offline' }}</span>
            <span>{{ saveLabel }}</span>
            <span>{{ store.syncStatus }}</span>
          </div>
        </div>
        <div class="actions">
          <button @click="showPlain = !showPlain">{{ showPlain ? 'WYSIWYG visning' : 'Plain markdown' }}</button>
        </div>
      </header>

      <div v-if="!showPlain && editor" class="editor-toolbar" aria-label="Editor toolbar">
        <button :class="{ active: editor.isActive('bold') }" @click="editor.chain().focus().toggleBold().run()"><strong>B</strong></button>
        <button :class="{ active: editor.isActive('italic') }" @click="editor.chain().focus().toggleItalic().run()"><em>I</em></button>
        <button :class="{ active: editor.isActive('strike') }" @click="editor.chain().focus().toggleStrike().run()"><s>S</s></button>
        <button :class="{ active: editor.isActive('heading', { level: 1 }) }" @click="editor.chain().focus().toggleHeading({ level: 1 }).run()">H1</button>
        <button :class="{ active: editor.isActive('heading', { level: 2 }) }" @click="editor.chain().focus().toggleHeading({ level: 2 }).run()">H2</button>
        <button :class="{ active: editor.isActive('heading', { level: 3 }) }" @click="editor.chain().focus().toggleHeading({ level: 3 }).run()">H3</button>
        <button :class="{ active: editor.isActive('bulletList') }" @click="editor.chain().focus().toggleBulletList().run()">• Liste</button>
        <button :class="{ active: editor.isActive('orderedList') }" @click="editor.chain().focus().toggleOrderedList().run()">1. Liste</button>
        <button :class="{ active: editor.isActive('taskList') }" @click="editor.chain().focus().toggleTaskList().run()">☑ Todo</button>
        <button :class="{ active: editor.isActive('link') }" @click="applyLink">Link</button>
        <button :class="{ active: editor.isActive('code') }" @click="editor.chain().focus().toggleCode().run()">&lt;/&gt;</button>
        <button :class="{ active: editor.isActive('codeBlock') }" @click="editor.chain().focus().toggleCodeBlock().run()">Kodeblok</button>
        <button :class="{ active: editor.isActive('blockquote') }" @click="editor.chain().focus().toggleBlockquote().run()">Quote</button>
        <button @click="editor.chain().focus().setHorizontalRule().run()">—</button>
      </div>

      <p v-if="error" class="error">{{ error }}</p>
      <section v-if="showPlain" class="plain-wrap">
        <textarea :value="store.currentContent" @input="store.setCurrentContent($event.target.value)"></textarea>
      </section>
      <section v-else class="wysiwyg-wrap">
        <EditorContent v-if="editor" :editor="editor" class="tiptap-root" />
      </section>
    </main>
  </div>
</template>
