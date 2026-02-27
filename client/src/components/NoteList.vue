<script setup lang="ts">
import { TransitionGroup, computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { KeyRound, LogOut, Plus, Search, Star, Sun, User, X } from 'lucide-vue-next'
import type { NoteMeta } from '../types'
import { t } from '../i18n'
import { currentTheme, setTheme } from '../theme'

interface Props {
  notes: NoteMeta[]
  selectedKey?: string
  noteContents: Record<string, string>
  userLabel?: string
}

const props = withDefaults(defineProps<Props>(), {
  selectedKey: ''
})

const emit = defineEmits<{
  (e: 'create', collection: string): void
  (e: 'select', key: string): void
  (e: 'toggle-pin', key: string): void
  (e: 'logout'): void
}>()

const query = ref('')
const userMenuWrap = ref<HTMLElement | null>(null)
const showUserMenu = ref(false)
const showPasswordForm = ref(false)
const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const passwordError = ref('')
const passwordSuccess = ref('')
const changingPassword = ref(false)

const COLLECTION_FILTER_ALL = '__all__'
const COLLECTION_FILTER_NONE = '__none__'
const collectionFilter = ref<string>(COLLECTION_FILTER_ALL)

const locale = typeof navigator !== 'undefined' ? navigator.language : 'en-US'
const collator = new Intl.Collator(locale, { sensitivity: 'base' })

const availableCollections = computed(() => {
  const values = Array.from(new Set(props.notes.map((note) => note.collection).filter(Boolean)))
  values.sort((a, b) => collator.compare(a, b))
  return values
})

watch(availableCollections, (allCollections) => {
  if (collectionFilter.value === COLLECTION_FILTER_ALL || collectionFilter.value === COLLECTION_FILTER_NONE) return
  if (!allCollections.includes(collectionFilter.value)) {
    collectionFilter.value = COLLECTION_FILTER_ALL
  }
})

const filteredNotes = computed(() => {
  const term = query.value.trim().toLowerCase()

  let base = props.notes
  if (collectionFilter.value === COLLECTION_FILTER_NONE) {
    base = base.filter((note) => !note.collection)
  } else if (collectionFilter.value !== COLLECTION_FILTER_ALL) {
    base = base.filter((note) => note.collection === collectionFilter.value)
  }

  if (!term) return base

  const titleMatches: NoteMeta[] = []
  const contentMatches: NoteMeta[] = []

  for (const note of base) {
    const titleMatch = note.title.toLowerCase().includes(term)
    if (titleMatch) {
      titleMatches.push(note)
      continue
    }

    const content = props.noteContents[note.key] || ''
    if (content.toLowerCase().includes(term)) {
      contentMatches.push(note)
    }
  }

  return [...titleMatches, ...contentMatches]
})

function clearQuery() {
  query.value = ''
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') clearQuery()
}

function onSelect(key: string) {
  emit('select', key)
}

function createInCurrentFilter() {
  if (collectionFilter.value === COLLECTION_FILTER_ALL || collectionFilter.value === COLLECTION_FILTER_NONE) {
    emit('create', '')
    return
  }
  emit('create', collectionFilter.value)
}

function toggleUserMenu() {
  showUserMenu.value = !showUserMenu.value
}

function onDocumentClick(event: MouseEvent) {
  const target = event.target as Node | null
  if (!target) return
  if (userMenuWrap.value?.contains(target)) return
  showUserMenu.value = false
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick)
})

function toggleTheme() {
  setTheme(currentTheme.value === 'default' ? 'summer' : 'default')
}

function togglePasswordForm() {
  showPasswordForm.value = !showPasswordForm.value
  passwordError.value = ''
  passwordSuccess.value = ''
  if (!showPasswordForm.value) {
    currentPassword.value = ''
    newPassword.value = ''
    confirmPassword.value = ''
  }
}

async function submitPasswordChange() {
  passwordError.value = ''
  passwordSuccess.value = ''

  if (!currentPassword.value || !newPassword.value || !confirmPassword.value) {
    passwordError.value = t('fillAllFields')
    return
  }

  if (newPassword.value !== confirmPassword.value) {
    passwordError.value = t('passwordMismatch')
    return
  }

  changingPassword.value = true
  try {
    const res = await fetch('/api/me/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentPassword: currentPassword.value,
        newPassword: newPassword.value
      })
    })

    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null
      throw new Error(data?.error || t('couldNotChangePassword'))
    }

    passwordSuccess.value = t('passwordUpdated')
    currentPassword.value = ''
    newPassword.value = ''
    confirmPassword.value = ''
  } catch (err) {
    passwordError.value = (err as Error)?.message || t('couldNotChangePassword')
  } finally {
    changingPassword.value = false
  }
}
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-header">
      <h1 class="app-logo">kladde</h1>
      <div ref="userMenuWrap" class="sidebar-header-actions">
        <div v-if="userLabel" class="user-menu-wrap">
          <button class="user-menu-button" :aria-label="t('userMenu')" @click="toggleUserMenu">
            <User :size="20" />
          </button>
        </div>
        <div v-if="userLabel && showUserMenu" class="user-menu-dropdown">
          <div class="user-menu-label">{{ userLabel }}</div>
          <button class="user-menu-item" @click="toggleTheme">
            <Sun :size="18" />
            {{ currentTheme === 'default' ? t('summerTheme') : t('defaultTheme') }}
          </button>
          <button class="user-menu-item" @click="togglePasswordForm">
            <KeyRound :size="18" />
            {{ t('changePassword') }}
          </button>
          <button class="user-menu-item" @click="emit('logout')">
            <LogOut :size="18" />
            {{ t('logout') }}
          </button>

          <form v-if="showPasswordForm" class="password-form" @submit.prevent="submitPasswordChange">
            <input v-model="currentPassword" class="password-input" type="password" autocomplete="current-password" :placeholder="t('currentPassword')" required />
            <input v-model="newPassword" class="password-input" type="password" autocomplete="new-password" :placeholder="t('newPassword')" required />
            <input v-model="confirmPassword" class="password-input" type="password" autocomplete="new-password" :placeholder="t('confirmNewPassword')" required />
            <p v-if="passwordError" class="password-error">{{ passwordError }}</p>
            <p v-if="passwordSuccess" class="password-success">{{ passwordSuccess }}</p>
            <button class="password-submit" type="submit" :disabled="changingPassword">{{ t('updatePassword') }}</button>
          </form>
        </div>

        <button class="create-fab" @click="createInCurrentFilter" :aria-label="t('createNewNote')">
          <Plus :size="20" />
        </button>
      </div>
    </div>

    <div class="search-controls">
      <div class="search-wrap">
        <Search class="search-icon" :size="18" />
        <input
          v-model="query"
          class="search-input"
          type="text"
          placeholder=""
          @keydown="onKeydown" />
        <button v-if="query" class="search-clear" :aria-label="t('clearSearch')" @click="clearQuery">
          <X :size="18" />
        </button>
      </div>

      <div class="collection-filter-wrap">
        <select v-model="collectionFilter" class="collection-filter-select" :aria-label="t('filterByCollection')">
          <option :value="COLLECTION_FILTER_ALL">{{ t('allCollections') }}</option>
          <option :value="COLLECTION_FILTER_NONE">{{ t('noCollection') }}</option>
          <option v-for="collection in availableCollections" :key="collection" :value="collection">{{ collection }}</option>
        </select>
      </div>
    </div>

    <TransitionGroup name="note-list" tag="div" class="list">
      <button
        v-for="note in filteredNotes"
        :key="note.key"
        class="note-item"
        :class="{ active: note.key === selectedKey }"
        @click="onSelect(note.key)">
        <div class="note-item-main">
          <strong>
            <span class="note-title-text">{{ note.title }}</span>
          </strong>
        </div>

        <div class="note-item-right">
          <span v-if="note.collection" class="note-collection-chip">{{ note.collection }}</span>
          <button
            class="pin"
            type="button"
            :aria-label="note.starred ? t('unpinNote') : t('pinNote')"
            @click.stop="emit('toggle-pin', note.key)">
            <Star :size="18" :fill="note.starred ? 'currentColor' : 'none'" />
          </button>
        </div>
      </button>
    </TransitionGroup>
  </aside>
</template>
