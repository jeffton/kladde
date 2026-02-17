<script setup lang="ts">
import { TransitionGroup, computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { FileText, KeyRound, LogOut, Plus, Search, Star, User, X } from 'lucide-vue-next'
import type { NoteMeta } from '../types'

interface Props {
  notes: NoteMeta[]
  selectedTitle?: string
  pinned: Set<string>
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
const sidebarRef = ref<HTMLElement | null>(null)
const userMenuWrap = ref<HTMLElement | null>(null)
const showUserMenu = ref(false)
const showPasswordForm = ref(false)
const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const passwordError = ref('')
const passwordSuccess = ref('')
const changingPassword = ref(false)

function capitalize(text = '') {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text
}

function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

const locale = navigator.language || 'en'
const rtf = typeof Intl.RelativeTimeFormat !== 'undefined' ? new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }) : null

function startOfWeek(date: Date) {
  const copy = new Date(date)
  copy.setHours(0, 0, 0, 0)
  const day = copy.getDay()
  copy.setDate(copy.getDate() - (day === 0 ? 6 : day - 1))
  return copy
}

function fmtTime(date: Date) {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(date)
}

function formatUpdatedAt(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  const now = new Date()
  const time = fmtTime(date)
  if (isSameDay(date, now)) return time

  if (date >= startOfWeek(now)) {
    const weekday = capitalize(new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(date))
    return `${weekday}, ${time}`
  }

  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

function buildSnippet(content: string, term: string) {
  const index = content.toLowerCase().indexOf(term.toLowerCase())
  if (index < 0) return ''
  const start = Math.max(0, index - 30)
  const end = Math.min(content.length, index + term.length + 50)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < content.length ? '…' : ''
  return `${prefix}${content.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`
}

const filteredNotes = computed(() => {
  const term = query.value.trim().toLowerCase()
  if (!term) return props.notes.map((note) => ({ note, snippet: '' }))

  return props.notes
    .map((note) => {
      const content = props.noteContents[note.title] || ''
      const titleMatch = note.title.toLowerCase().includes(term)
      const contentMatch = content.toLowerCase().includes(term)
      if (!titleMatch && !contentMatch) return null
      return { note, snippet: contentMatch ? buildSnippet(content, term) : '' }
    })
    .filter((item): item is { note: NoteMeta; snippet: string } => Boolean(item))
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
    passwordError.value = 'Udfyld alle felter'
    return
  }

  if (newPassword.value !== confirmPassword.value) {
    passwordError.value = 'Ny adgangskode og bekræftelse matcher ikke'
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
      throw new Error(data?.error || 'Kunne ikke skifte adgangskode')
    }

    passwordSuccess.value = 'Adgangskoden er opdateret'
    currentPassword.value = ''
    newPassword.value = ''
    confirmPassword.value = ''
  } catch (err) {
    passwordError.value = (err as Error)?.message || 'Kunne ikke skifte adgangskode'
  } finally {
    changingPassword.value = false
  }
}
</script>

<template>
  <aside ref="sidebarRef" class="sidebar">
    <div class="sidebar-header">
      <h1>kladde</h1>
      <div style="display: flex; gap: .35rem; align-items: center;">
        <div v-if="userLabel" ref="userMenuWrap" class="user-menu-wrap">
          <button class="user-menu-button" aria-label="Brugermenu" @click="toggleUserMenu">
            <User :size="20" />
          </button>
          <div v-if="showUserMenu" class="user-menu-dropdown">
            <div class="user-menu-label">{{ userLabel }}</div>
            <button class="user-menu-item" @click="togglePasswordForm">
              <KeyRound :size="18" />
              Skift password
            </button>
            <button class="user-menu-item" @click="emit('logout')">
              <LogOut :size="18" />
              Log ud
            </button>

            <form v-if="showPasswordForm" class="password-form" @submit.prevent="submitPasswordChange">
              <input v-model="currentPassword" class="password-input" type="password" autocomplete="current-password" placeholder="Nuværende password" required />
              <input v-model="newPassword" class="password-input" type="password" autocomplete="new-password" placeholder="Nyt password" required />
              <input v-model="confirmPassword" class="password-input" type="password" autocomplete="new-password" placeholder="Bekræft nyt password" required />
              <p v-if="passwordError" class="password-error">{{ passwordError }}</p>
              <p v-if="passwordSuccess" class="password-success">{{ passwordSuccess }}</p>
              <button class="password-submit" type="submit" :disabled="changingPassword">Opdater password</button>
            </form>
          </div>
        </div>

        <button class="create-fab" @click="emit('create')" aria-label="Opret ny note">
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
        placeholder="Søg"
        @keydown="onKeydown" />
      <button v-if="query" class="search-clear" aria-label="Ryd søgning" @click="clearQuery">
        <X :size="18" />
      </button>
    </div>

    <TransitionGroup name="note-list" tag="div" class="list">
      <button
        v-for="item in filteredNotes"
        :key="item.note.title"
        class="note-item"
        :class="{ active: item.note.title === selectedTitle }"
        @click="onSelect(item.note.title)">
        <div>
          <strong>
            <FileText :size="16" class="note-title-icon" />
            {{ item.note.title }}
          </strong>
          <small>{{ formatUpdatedAt(item.note.updatedAt) }}</small>
          <small v-if="item.snippet" class="snippet">{{ item.snippet }}</small>
        </div>
        <span
          class="pin"
          :aria-label="pinned.has(item.note.title) ? 'Fjern stjerne' : 'Stjernemarkér note'"
          @click.stop="emit('toggle-pin', item.note.title)">
          <Star :size="18" :fill="pinned.has(item.note.title) ? 'currentColor' : 'none'" />
        </span>
      </button>
    </TransitionGroup>

  </aside>
</template>
