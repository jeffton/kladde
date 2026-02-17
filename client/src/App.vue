<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useNotesStore } from './stores/notes'
import NoteList from './components/NoteList.vue'
import EditorView from './components/EditorView.vue'
import { useAutosave } from './composables/useAutosave'

const store = useNotesStore()
const route = useRoute()
const router = useRouter()
const error = ref('')

const sortedNotes = computed(() => store.sortedNotes)
const isMobile = ref(window.matchMedia('(max-width: 900px)').matches)
const isListRoute = computed(() => route.name === 'list')
const mobileTransitionName = ref('slide-from-right')
const currentMobileView = computed<'list' | 'editor'>(() => (isListRoute.value ? 'list' : 'editor'))
let previousMobileView: 'list' | 'editor' = currentMobileView.value

const appShellClass = computed(() => ({
  'mobile-list-view': isMobile.value && isListRoute.value,
  'mobile-editor-view': isMobile.value && !isListRoute.value
}))

async function selectNote(title: string, replace = false) {
  try {
    await store.selectNote(title)
    error.value = ''
    const target = { name: 'note', params: { title } }
    if (replace) await router.replace(target)
    else await router.push(target)
  } catch (e) {
    error.value = (e as Error).message
  }
}

async function createNote() {
  try {
    const title = await store.createNote()
    error.value = ''
    await router.push({ name: 'note', params: { title } })
  } catch (e) {
    error.value = (e as Error).message
  }
}

function onRename(renamedTitle: string) {
  void router.replace({ name: 'note', params: { title: renamedTitle } })
}

function goBackToList() {
  void router.push({ name: 'list' })
}

function onDeleted() {
  void router.push({ name: 'list' })
}

function togglePin(title: string) {
  store.togglePin(title)
}

const online = () => store.setOnline(true)
const offline = () => store.setOnline(false)

useAutosave({
  store,
  onError: (err) => {
    error.value = (err as Error)?.message || 'En fejl opstod'
  }
})

watch(
  () => route.params.title,
  async (value) => {
    const title = typeof value === 'string' ? value : ''
    if (!title) return
    if (title !== store.selectedTitle) await selectNote(title, true)
  }
)

watch(currentMobileView, (nextView) => {
  if (!isMobile.value) {
    previousMobileView = nextView
    return
  }

  if (previousMobileView === 'list' && nextView === 'editor') {
    mobileTransitionName.value = 'slide-from-right'
  } else if (previousMobileView === 'editor' && nextView === 'list') {
    mobileTransitionName.value = 'slide-from-left'
  }

  previousMobileView = nextView
})

let media: MediaQueryList | null = null
let mediaListener: ((event: MediaQueryListEvent) => void) | null = null

onMounted(async () => {
  try {
    await store.initialize()

    const title = typeof route.params.title === 'string' ? route.params.title : ''
    if (title) {
      await selectNote(title, true)
    } else if (!isMobile.value && store.selectedTitle) {
      await router.replace({ name: 'note', params: { title: store.selectedTitle } })
    }
  } catch (e) {
    error.value = (e as Error).message
  }

  media = window.matchMedia('(max-width: 900px)')
  mediaListener = (event: MediaQueryListEvent) => {
    isMobile.value = event.matches
  }

  media.addEventListener('change', mediaListener)
  window.addEventListener('online', online)
  window.addEventListener('offline', offline)
})

onUnmounted(() => {
  if (media && mediaListener) media.removeEventListener('change', mediaListener)
  window.removeEventListener('online', online)
  window.removeEventListener('offline', offline)
})
</script>

<template>
  <div class="app-shell" :class="appShellClass">
    <template v-if="isMobile">
      <NoteList
        v-if="isListRoute"
        :notes="sortedNotes"
        :selected-title="store.selectedTitle"
        :pinned="store.pinned"
        :note-contents="store.noteContents"
        @create="createNote"
        @select="selectNote"
        @toggle-pin="togglePin" />

      <EditorView
        v-else
        :store="store"
        :show-back="true"
        @rename="onRename"
        @back="goBackToList"
        @deleted="onDeleted" />
    </template>

    <template v-else>
      <NoteList
        :notes="sortedNotes"
        :selected-title="store.selectedTitle"
        :pinned="store.pinned"
        :note-contents="store.noteContents"
        @create="createNote"
        @select="selectNote"
        @toggle-pin="togglePin" />

      <EditorView
        :store="store"
        :show-back="false"
        @rename="onRename"
        @back="goBackToList"
        @deleted="onDeleted" />
    </template>
  </div>
  <p v-if="error" class="error">{{ error }}</p>
</template>
