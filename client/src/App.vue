<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useNotesStore } from './stores/notes'
import NoteList from './components/NoteList.vue'
import EditorView from './components/EditorView.vue'
import { useRouting } from './composables/useRouting'
import { useAutosave } from './composables/useAutosave'

const store = useNotesStore()
const error = ref('')

const sortedNotes = computed(() => store.sortedNotes)

async function selectNote(title, fromRoute = false) {
  try {
    await store.selectNote(title)
    if (isMobile.value) mobileView.value = 'editor'
    error.value = ''
    if (!fromRoute) pushCurrentHistory()
  } catch (e) {
    error.value = e.message
  }
}

const {
  isMobile,
  mobileView,
  pushCurrentHistory,
  applyRouteFromLocation,
  replaceWithTitle,
  goBackToList
} = useRouting({ store, selectNote })

function onRename(renamedTitle) {
  replaceWithTitle(renamedTitle)
}

async function createNote() {
  try {
    await store.createNote()
    if (isMobile.value) mobileView.value = 'editor'
    error.value = ''
    pushCurrentHistory()
  } catch (e) {
    error.value = e.message
  }
}

function togglePin(title) {
  store.togglePin(title)
}

const online = () => store.setOnline(true)
const offline = () => store.setOnline(false)

useAutosave({
  store,
  onError: (err) => {
    error.value = err?.message || 'En fejl opstod'
  }
})

let media = null
let mediaListener = null
let popStateHandler = null

onMounted(async () => {
  try {
    await store.initialize()
    await applyRouteFromLocation(true)
  } catch (e) {
    error.value = e.message
  }

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
})

onUnmounted(() => {
  if (media && mediaListener) media.removeEventListener('change', mediaListener)
  if (popStateHandler) window.removeEventListener('popstate', popStateHandler)
  window.removeEventListener('online', online)
  window.removeEventListener('offline', offline)
})
</script>

<template>
  <div class="app-shell" :class="{ 'mobile-list-view': isMobile && mobileView === 'list', 'mobile-editor-view': isMobile && mobileView === 'editor' }">
    <NoteList
      :notes="sortedNotes"
      :selected-title="store.selectedTitle"
      :pinned="store.pinned"
      @create="createNote"
      @select="selectNote"
      @toggle-pin="togglePin" />

    <EditorView
      :store="store"
      :is-mobile="isMobile"
      :mobile-view="mobileView"
      @rename="onRename"
      @back="goBackToList" />
  </div>
  <p v-if="error" class="error">{{ error }}</p>
</template>
