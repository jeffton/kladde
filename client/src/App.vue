<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useNotesStore } from './stores/notes'
import NoteList from './components/NoteList.vue'
import EditorView from './components/EditorView.vue'
import { useAutosave } from './composables/useAutosave'
import type { AuthUser } from './types'
import { t } from './i18n'

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

const AUTH_USER_STORAGE_KEY = 'kladde.auth.user'
const ME_REQUEST_TIMEOUT_MS = 2000

function readCachedAuthUser(): AuthUser | null {
  try {
    const raw = window.localStorage.getItem(AUTH_USER_STORAGE_KEY)
    if (!raw) return null

    const parsed = JSON.parse(raw) as Partial<AuthUser>
    const usernameValue = typeof parsed?.username === 'string' ? parsed.username : ''
    const displayNameValue = typeof parsed?.displayName === 'string' ? parsed.displayName : ''

    if (!usernameValue && !displayNameValue) return null

    return {
      username: usernameValue,
      displayName: displayNameValue
    }
  } catch {
    return null
  }
}

function writeCachedAuthUser(nextUser: AuthUser | null) {
  try {
    if (!nextUser) {
      window.localStorage.removeItem(AUTH_USER_STORAGE_KEY)
      return
    }

    window.localStorage.setItem(AUTH_USER_STORAGE_KEY, JSON.stringify(nextUser))
  } catch {
    // Ignore storage failures.
  }
}

const cachedAuthUser = readCachedAuthUser()
if (cachedAuthUser) {
  user.value = cachedAuthUser
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

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

function clearUiError() {
  error.value = ''
}

function setUiError(err: unknown) {
  if (isUnauthorized(err)) {
    user.value = null
    writeCachedAuthUser(null)
    clearUiError()
    return
  }

  if (isNetworkError(err)) {
    clearUiError()
    return
  }

  error.value = (err as Error)?.message || t('genericError')
}

function setUiErrorMessage(message: string) {
  error.value = message || t('genericError')
}

async function loadMe(background = false) {
  try {
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), ME_REQUEST_TIMEOUT_MS)

    let res: Response
    try {
      res = await fetch('/api/me', { signal: controller.signal })
    } finally {
      window.clearTimeout(timer)
    }

    if (res.status === 401) {
      user.value = null
      writeCachedAuthUser(null)
      return
    }

    if (!res.ok) throw new Error(t('couldNotLoadUser'))

    const me = (await res.json()) as AuthUser
    user.value = me
    writeCachedAuthUser(me)
  } catch (err: unknown) {
    if (isAbortError(err) || isNetworkError(err)) {
      return
    }

    if (!user.value) {
      user.value = null
      writeCachedAuthUser(null)
    }
  } finally {
    if (!background) {
      authChecked.value = true
    }
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
      loginError.value = t('wrongCredentials')
      return
    }
    if (!res.ok) throw new Error(t('couldNotLogin'))

    user.value = (await res.json()) as AuthUser
    writeCachedAuthUser(user.value)
    password.value = ''
    await store.initialize()
  } catch {
    loginError.value = t('couldNotLoginNow')
  } finally {
    loggingIn.value = false
  }
}

async function logout() {
  try {
    await fetch('/auth/logout', { method: 'POST' })
  } finally {
    user.value = null
    writeCachedAuthUser(null)
    clearUiError()
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

let selectRequestId = 0

async function selectNote(title: string, replace = false, withTransition = true) {
  const requestId = ++selectRequestId

  try {
    await store.selectNote(title)
    if (requestId !== selectRequestId) return

    clearUiError()
    const target = { name: 'note', params: { title } }
    if (withTransition) setMobileTransition('slide-from-right')
    if (replace) await router.replace(target)
    else await router.push(target)
  } catch (e) {
    if (requestId !== selectRequestId) return
    setUiError(e)
  }
}

async function createNote() {
  try {
    const title = await store.createNote()
    clearUiError()
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

async function togglePin(title: string) {
  try {
    await store.togglePin(title)
  } catch (e) {
    setUiError(e)
  }
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

watch(
  () => store.selectedTitle,
  async (title) => {
    if (!isAuthenticated.value || !title) return
    if (route.name !== 'note') return

    const routeTitle = typeof route.params.title === 'string' ? route.params.title : ''
    if (routeTitle === title) return

    await router.replace({ name: 'note', params: { title } })
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
let visualViewport: VisualViewport | null = null
let viewportListener: (() => void) | null = null

function isIOSDevice(): boolean {
  const ua = navigator.userAgent
  const platform = navigator.platform

  const iosByUa = /iPad|iPhone|iPod/.test(ua)
  const ipadOsDesktopUa = platform === 'MacIntel' && navigator.maxTouchPoints > 1

  return iosByUa || ipadOsDesktopUa
}

function updateIOSViewportHeight() {
  if (!visualViewport) return

  const viewportHeight = Math.round(visualViewport.height)
  const fullHeight = Math.round(window.innerHeight)

  const keyboardOpen = fullHeight - viewportHeight > 120

  if (Math.abs(fullHeight - viewportHeight) < 2) {
    document.documentElement.style.removeProperty('--app-height')
  } else {
    document.documentElement.style.setProperty('--app-height', `${viewportHeight}px`)
  }

  document.documentElement.classList.toggle('ios-keyboard-open', keyboardOpen)

  window.scrollTo(0, 0)
}

let storeInitialized = false

async function initializeAuthenticatedSession() {
  if (!isAuthenticated.value || storeInitialized) return

  try {
    storeInitialized = true
    await store.initialize()

    const title = typeof route.params.title === 'string' ? route.params.title : ''
    if (title) {
      await selectNote(title, true, false)
    } else if (!isMobile.value && store.selectedTitle) {
      await router.replace({ name: 'note', params: { title: store.selectedTitle } })
    }
  } catch (e) {
    storeInitialized = false
    setUiError(e)
  }
}

onMounted(async () => {
  if (isAuthenticated.value) {
    authChecked.value = true
    await initializeAuthenticatedSession()
    void loadMe(true)
  } else {
    await loadMe()
    await initializeAuthenticatedSession()
  }

  media = window.matchMedia('(max-width: 900px)')
  mediaListener = (event: MediaQueryListEvent) => {
    isMobile.value = event.matches
  }

  media.addEventListener('change', mediaListener)
  window.addEventListener('online', online)
  window.addEventListener('offline', offline)

  if (isIOSDevice() && window.visualViewport) {
    visualViewport = window.visualViewport
    viewportListener = () => {
      updateIOSViewportHeight()
    }

    visualViewport.addEventListener('resize', viewportListener)
    visualViewport.addEventListener('scroll', viewportListener)
    updateIOSViewportHeight()
  }
})

onUnmounted(() => {
  if (media && mediaListener) media.removeEventListener('change', mediaListener)
  window.removeEventListener('online', online)
  window.removeEventListener('offline', offline)

  if (visualViewport && viewportListener) {
    visualViewport.removeEventListener('resize', viewportListener)
    visualViewport.removeEventListener('scroll', viewportListener)
  }

  document.documentElement.style.removeProperty('--app-height')
  removeAfterEach()
})
</script>

<template>
  <div v-if="!authChecked" class="login-shell">
    <div class="login-card">
      <h1 class="app-logo">kladde</h1>
    </div>
  </div>

  <div v-else-if="!isAuthenticated" class="login-shell">
    <div class="login-card">
      <h1 class="app-logo">kladde</h1>
      <form class="login-form" @submit.prevent="login">
        <input v-model="username" class="login-input" type="text" autocomplete="username" :placeholder="t('username')" required />
        <input
          v-model="password"
          class="login-input"
          type="password"
          autocomplete="current-password"
          :placeholder="t('password')"
          required />
        <p v-if="loginError" class="login-error" role="alert" aria-live="assertive">{{ loginError }}</p>
        <button class="login-button" type="submit" :disabled="loggingIn">{{ t('login') }}</button>
      </form>
    </div>
  </div>

  <div v-else class="app-shell" :class="appShellClass">
    <Transition name="error-overlay">
      <div v-if="error" class="error-overlay" role="alert" aria-live="assertive">
        <p class="error-overlay-text">{{ error }}</p>
        <button class="error-overlay-close" type="button" :aria-label="t('dismissError')" @click="clearUiError">×</button>
      </div>
    </Transition>

    <template v-if="isMobile">
      <Transition :name="mobileTransitionName">
        <NoteList
          v-show="isListRoute"
          :notes="sortedNotes"
          :selected-title="store.selectedTitle"
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
          @deleted="onDeleted"
          @ui-error="setUiErrorMessage" />
      </Transition>
    </template>

    <template v-else>
      <NoteList
        :notes="sortedNotes"
        :selected-title="store.selectedTitle"
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
        @deleted="onDeleted"
        @ui-error="setUiErrorMessage" />
    </template>
  </div>
</template>
