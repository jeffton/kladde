<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import Editor from '@toast-ui/editor'
import { useNotesStore } from './stores/notes'

const store = useNotesStore()
const editorEl = ref(null)
const editor = ref(null)
const showPlain = ref(false)
const newTitle = ref('')
const error = ref('')
let syncingEditor = false

const sortedNotes = computed(() => store.sortedNotes)

function setEditorContent(content) {
  if (!editor.value) return
  const current = editor.value.getMarkdown()
  if (current === (content || '')) return
  syncingEditor = true
  editor.value.setMarkdown(content || '')
  setTimeout(() => {
    syncingEditor = false
  }, 0)
}

async function load() {
  try {
    await store.fetchNotes()
    setEditorContent(store.currentContent)
  } catch (e) {
    error.value = e.message
  }
}

onMounted(async () => {
  editor.value = new Editor({
    el: editorEl.value,
    height: '65vh',
    initialEditType: 'wysiwyg',
    previewStyle: 'vertical',
    usageStatistics: false,
    linkAttributes: { target: '_blank', rel: 'noopener noreferrer' }
  })

  editor.value.on('change', () => {
    if (syncingEditor) return
    const markdown = editor.value.getMarkdown()
    if (markdown !== store.currentContent) store.setCurrentContent(markdown)
  })

  await load()

  const online = () => store.setOnline(true)
  const offline = () => store.setOnline(false)
  window.addEventListener('online', online)
  window.addEventListener('offline', offline)

  const autosave = setInterval(async () => {
    if (!store.online || !store.dirty) return
    try { await store.saveCurrent(); error.value = '' } catch {}
  }, 2500)

  const sync = setInterval(async () => {
    if (!store.online) return
    try {
      await store.fetchNotes()
      if (!showPlain.value) setEditorContent(store.currentContent)
      error.value = ''
    } catch {}
  }, 15000)

  onUnmounted(() => {
    window.removeEventListener('online', online)
    window.removeEventListener('offline', offline)
    clearInterval(autosave)
    clearInterval(sync)
    editor.value?.destroy()
  })
})

watch(showPlain, (isPlain) => {
  if (!isPlain) setEditorContent(store.currentContent)
})

async function selectNote(title) {
  try {
    await store.selectNote(title)
    if (!showPlain.value) setEditorContent(store.currentContent)
    error.value = ''
  } catch (e) {
    error.value = e.message
  }
}

async function createNote() {
  if (!newTitle.value.trim()) return
  try {
    await store.createNote(newTitle.value.trim())
    newTitle.value = ''
    setEditorContent(store.currentContent)
    error.value = ''
  } catch (e) {
    error.value = e.message
  }
}

function togglePin(title) { store.togglePin(title) }

async function manualSave() {
  try { await store.saveCurrent(); error.value = '' } catch (e) { error.value = e.message }
}
</script>

<template>
  <div class="app-shell">
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
        <div class="status">
          <span :class="store.online ? 'online' : 'offline'">{{ store.online ? 'Online' : 'Offline' }}</span>
          <span>{{ store.saveStatus }}</span>
          <span v-if="store.dirty">Ikke gemt</span>
        </div>
        <div class="actions">
          <button @click="showPlain = !showPlain">{{ showPlain ? 'WYSIWYG visning' : 'Plain markdown' }}</button>
          <button @click="manualSave">Gem nu</button>
        </div>
      </header>

      <p v-if="error" class="error">{{ error }}</p>
      <section v-if="showPlain" class="plain-wrap">
        <textarea :value="store.currentContent" @input="store.setCurrentContent($event.target.value)"></textarea>
      </section>
      <section v-else class="wysiwyg-wrap"><div ref="editorEl"></div></section>
    </main>
  </div>
</template>
