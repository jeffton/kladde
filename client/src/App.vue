<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useNotesStore } from './stores/notes'
import NoteList from './components/NoteList.vue'
import EditorView from './components/EditorView.vue'
import { useAutosave } from './composables/useAutosave'
import type { AuthUser } from './types'

const store = useNotesStore()
const route = useRoute()
const router = useRouter()
const error = ref('')
const authChecked = ref(false)
const user = ref<AuthUser | null>(null)

const isAuthenticated = computed(() => Boolean(user.value))
const userLabel = computed(() => user.value?.displayName || user.value?.username || '')
const username = ref('')
const password = ref('')
const loginError = ref('')
const loggingIn = ref(false)

function isNetworkError(err: unknown): boolean {
  if (!err) return false
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true

  const message = (err as Error)?.message || ''
  const normalized = message.toLowerCase()

  return (
    normalized.includes('failed to fetch') ||
    normalized.includes('networkerror') ||
    normalized.includes('network request failed') ||
    normalized.includes('load failed')
  )
}

function isUnauthorized(err: unknown): boolean {
  return (err as Error)?.message === 'UNAUTHORIZED'
}

function setUiError(err: unknown) {
  if (isUnauthorized(err)) {
    user.value = null
    error.value = ''
    return
  }

  if (isNetworkError(err)) {
    error.value = ''
    return
  }
  error.value = (err as Error)?.message || 'En fejl opstod'
}

async function loadMe() {
  try {
    const res = await fetch('/api/me')
    if (res.status === 401) {
      user.value = null
      return
    }
    if (!res.ok) throw new Error('Kunne ikke hente bruger')
    user.value = (await res.json()) as AuthUser
  } finally {
    authChecked.value = true
  }
}

async function login() {
  loginError.value = ''
  loggingIn.value = true

  try {
    const res = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username.value, password: password.value })
    })

    if (res.status === 401) {
      loginError.value = 'Forkert brugernavn eller adgangskode'
      return
    }
    if (!res.ok) throw new Error('Kunne ikke logge ind')

    user.value = (await res.json()) as AuthUser
    password.value = ''
  } catch {
    loginError.value = 'Kunne ikke logge ind lige nu'
  } finally {
    loggingIn.value = false
  }
}

async function logout() {
  try {
    await fetch('/auth/logout', { method: 'POST' })
  } finally {
    user.value = null
    error.value = ''
    loginError.value = ''
  }
}

const sortedNotes = computed(() => store.sortedNotes)
const isMobile = ref(window.matchMedia('(max-width: 900px)').matches)
const isListRoute = computed(() => route.name === 'list')
const mobileTransitionName = ref<'' | 'slide-from-right' | 'slide-from-left'>('')

const appShellClass = computed(() => ({
  'mobile-list-view': isMobile.value && isListRoute.value,
  'mobile-editor-view': isMobile.value && !isListRoute.value
}))

function setMobileTransition(name: '' | 'slide-from-right' | 'slide-from-left') {
  mobileTransitionName.value = isMobile.value ? name : ''
}

async function selectNote(title: string, replace = false, withTransition = true) {
  try {
    await store.selectNote(title)
    error.value = ''
    const target = { name: 'note', params: { title } }
    if (withTransition) setMobileTransition('slide-from-right')
    if (replace) await router.replace(target)
    else await router.push(target)
  } catch (e) {
    setUiError(e)
  }
}

async function createNote() {
  try {
    const title = await store.createNote()
    error.value = ''
    setMobileTransition('slide-from-right')
    await router.push({ name: 'note', params: { title } })
  } catch (e) {
    setUiError(e)
  }
}

function onRename(renamedTitle: string) {
  void router.replace({ name: 'note', params: { title: renamedTitle } })
}

function goBackToList() {
  setMobileTransition('slide-from-left')
  void router.push({ name: 'list' })
}

function onDeleted() {
  setMobileTransition('slide-from-left')
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
    setUiError(err)
  }
})

watch(
  () => route.params.title,
  async (value) => {
    if (!isAuthenticated.value) return

    const title = typeof value === 'string' ? value : ''
    if (!title) return
    if (title !== store.selectedTitle) await selectNote(title, true, false)
  }
)

const removeAfterEach = router.afterEach(() => {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      mobileTransitionName.value = ''
    })
  })
})

let media: MediaQueryList | null = null
let mediaListener: ((event: MediaQueryListEvent) => void) | null = null

onMounted(async () => {
  await loadMe()

  if (isAuthenticated.value) {
    try {
      await store.initialize()

      const title = typeof route.params.title === 'string' ? route.params.title : ''
      if (title) {
        await selectNote(title, true, false)
      } else if (!isMobile.value && store.selectedTitle) {
        await router.replace({ name: 'note', params: { title: store.selectedTitle } })
      }
    } catch (e) {
      setUiError(e)
    }
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
  removeAfterEach()
})
</script>

<template>
  <div v-if="!authChecked" class="login-shell">
    <div class="login-card">
      <h1>kladde</h1>
    </div>
  </div>

  <div v-else-if="!isAuthenticated" class="login-shell">
    <div class="login-card">
      <h1>kladde</h1>
      <form class="login-form" @submit.prevent="login">
        <input v-model="username" class="login-input" type="text" autocomplete="username" placeholder="Brugernavn" required />
        <input
          v-model="password"
          class="login-input"
          type="password"
          autocomplete="current-password"
          placeholder="Adgangskode"
          required />
        <p v-if="loginError" class="login-error">{{ loginError }}</p>
        <button class="login-button" type="submit" :disabled="loggingIn">Log ind</button>
      </form>
    </div>
  </div>

  <div v-else class="app-shell" :class="appShellClass">
    <p v-if="error" class="error">{{ error }}</p>

    <template v-if="isMobile">
      <Transition :name="mobileTransitionName">
        <NoteList
          v-show="isListRoute"
          :notes="sortedNotes"
          :selected-title="store.selectedTitle"
          :pinned="store.pinned"
          :note-contents="store.noteContents"
          :user-label="userLabel"
          @create="createNote"
          @select="selectNote"
          @toggle-pin="togglePin"
          @logout="logout" />
      </Transition>

      <Transition :name="mobileTransitionName">
        <EditorView
          v-show="!isListRoute"
          :store="store"
          :show-back="true"
          @rename="onRename"
          @back="goBackToList"
          @deleted="onDeleted" />
      </Transition>
    </template>

    <template v-else>
      <NoteList
        :notes="sortedNotes"
        :selected-title="store.selectedTitle"
        :pinned="store.pinned"
        :note-contents="store.noteContents"
        :user-label="userLabel"
        @create="createNote"
        @select="selectNote"
        @toggle-pin="togglePin"
        @logout="logout" />

      <EditorView
        :store="store"
        :show-back="false"
        @rename="onRename"
        @back="goBackToList"
        @deleted="onDeleted" />
    </template>
  </div>
</template>
