<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { Editor, rootCtx, defaultValueCtx } from '@milkdown/core'
import { commonmark } from '@milkdown/preset-commonmark'
import { nord } from '@milkdown/theme-nord'
import { listener, listenerCtx } from '@milkdown/plugin-listener'
import { useNotesStore } from './stores/notes'

const store = useNotesStore()
const editorEl = ref(null)
const milkdownEditor = ref(null)
const showPlain = ref(false)
const sidebarOpen = ref(false)
const newTitle = ref('')
const error = ref('')
let ignoreEditorChanges = false
let autosaveTimer = null
let syncTimer = null
let lastRenderedMarkdown = null
const online = () => store.setOnline(true)
const offline = () => store.setOnline(false)

const sortedNotes = computed(() => store.sortedNotes)

const saveLabel = computed(() => {
  if (store.dirty) return 'Ikke gemt'
  if (store.saveStatus === 'Gemmer…') return 'Gemmer...'
  if (store.saveStatus === 'Fejl ved gem') return 'Ikke gemt'
  return 'Gemt'
})

async function destroyEditor() {
  if (!milkdownEditor.value) return
  await milkdownEditor.value.destroy()
  milkdownEditor.value = null
}

async function createEditor(content = '') {
  await destroyEditor()
  await nextTick()
  if (!editorEl.value) return

  ignoreEditorChanges = true

  milkdownEditor.value = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, editorEl.value)
      ctx.set(defaultValueCtx, content || '')
      ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
        if (ignoreEditorChanges) return
        if (markdown !== store.currentContent) store.setCurrentContent(markdown)
      })
    })
    .use(commonmark)
    .use(listener)
    .use(nord)
    .create()

  lastRenderedMarkdown = content || ''

  setTimeout(() => {
    ignoreEditorChanges = false
  }, 0)
}

async function load() {
  try {
    await store.fetchNotes()
    if (!showPlain.value) await createEditor(store.currentContent)
  } catch (e) {
    error.value = e.message
  }
}

async function selectNote(title) {
  try {
    await store.selectNote(title)
    if (!showPlain.value) await createEditor(store.currentContent)
    error.value = ''
    sidebarOpen.value = false
  } catch (e) {
    error.value = e.message
  }
}

async function createNote() {
  if (!newTitle.value.trim()) return
  try {
    await store.createNote(newTitle.value.trim())
    newTitle.value = ''
    if (!showPlain.value) await createEditor(store.currentContent)
    error.value = ''
    sidebarOpen.value = false
  } catch (e) {
    error.value = e.message
  }
}

function togglePin(title) {
  store.togglePin(title)
}

watch(showPlain, async (isPlain) => {
  if (!isPlain) {
    await createEditor(store.currentContent)
  } else {
    await destroyEditor()
  }
})

onMounted(async () => {
  await load()

  window.addEventListener('online', online)
  window.addEventListener('offline', offline)

  autosaveTimer = setInterval(async () => {
    if (!store.online || !store.dirty) return
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
      await store.fetchNotes()
      if (!showPlain.value && !store.dirty && store.currentContent !== lastRenderedMarkdown) {
        await createEditor(store.currentContent)
      }
      error.value = ''
    } catch {
      // ignore transient sync errors
    }
  }, 15000)
})

onUnmounted(async () => {
  window.removeEventListener('online', online)
  window.removeEventListener('offline', offline)
  clearInterval(autosaveTimer)
  clearInterval(syncTimer)
  await destroyEditor()
})
</script>

<template>
  <div class="app-shell" :class="{ 'mobile-sidebar-open': sidebarOpen }">
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
          <button class="mobile-only" @click="sidebarOpen = !sidebarOpen">{{ sidebarOpen ? 'Luk noter' : 'Noter' }}</button>
          <div class="status">
            <span :class="store.online ? 'online' : 'offline'">{{ store.online ? 'Online' : 'Offline' }}</span>
            <span>{{ saveLabel }}</span>
          </div>
        </div>
        <div class="actions">
          <button @click="showPlain = !showPlain">{{ showPlain ? 'WYSIWYG visning' : 'Plain markdown' }}</button>
        </div>
      </header>

      <p v-if="error" class="error">{{ error }}</p>
      <section v-if="showPlain" class="plain-wrap">
        <textarea :value="store.currentContent" @input="store.setCurrentContent($event.target.value)"></textarea>
      </section>
      <section v-else class="wysiwyg-wrap"><div ref="editorEl" class="milkdown-root"></div></section>
    </main>
  </div>
</template>
