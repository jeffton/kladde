<script setup lang="ts">
import { TransitionGroup, computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { FileText, KeyRound, LogOut, Plus, Search, Star, User, X } from 'lucide-vue-next'
import type { NoteMeta } from '../types'
import { t } from '../i18n'

interface Props {
  notes: NoteMeta[]
  selectedTitle?: string
  noteContents: Record<string, string>
  userLabel?: string
}

const props = withDefaults(defineProps<Props>(), {
  selectedTitle: ''
})

const emit = defineEmits<{
  (e: 'create'): void
  (e: 'select', title: string): void
  (e: 'toggle-pin', title: string): void
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

const filteredNotes = computed(() => {
  const term = query.value.trim().toLowerCase()
  if (!term) return props.notes

  const titleMatches: NoteMeta[] = []
  const contentMatches: NoteMeta[] = []

  for (const note of props.notes) {
    const titleMatch = note.title.toLowerCase().includes(term)
    if (titleMatch) {
      titleMatches.push(note)
      continue
    }

    const content = props.noteContents[note.title] || ''
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

function onSelect(title: string) {
  emit('select', title)
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

        <button class="create-fab" @click="emit('create')" :aria-label="t('createNewNote')">
          <Plus :size="20" />
        </button>
      </div>
    </div>

    <div class="search-wrap">
      <Search class="search-icon" :size="18" />
      <input
        v-model="query"
        class="search-input"
        type="text"
        :placeholder="t('search')"
        @keydown="onKeydown" />
      <button v-if="query" class="search-clear" :aria-label="t('clearSearch')" @click="clearQuery">
        <X :size="18" />
      </button>
    </div>

    <TransitionGroup name="note-list" tag="div" class="list">
      <button
        v-for="note in filteredNotes"
        :key="note.title"
        class="note-item"
        :class="{ active: note.title === selectedTitle }"
        @click="onSelect(note.title)">
        <div>
          <strong>
            <span class="note-title-text">{{ note.title }}</span>
          </strong>
        </div>
        <button
          class="pin"
          type="button"
          :aria-label="note.starred ? t('unpinNote') : t('pinNote')"
          @click.stop="emit('toggle-pin', note.title)">
          <Star :size="18" :fill="note.starred ? 'currentColor' : 'none'" />
        </button>
      </button>
    </TransitionGroup>

  </aside>
</template>
