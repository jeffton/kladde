<script setup lang="ts">
import { computed, ref } from 'vue'
import type { NoteMeta } from '../types'

interface Props {
  notes: NoteMeta[]
  selectedTitle?: string
  pinned: Set<string>
  noteContents: Record<string, string>
}

const props = withDefaults(defineProps<Props>(), {
  selectedTitle: ''
})

const emit = defineEmits<{
  (e: 'create'): void
  (e: 'select', title: string): void
  (e: 'toggle-pin', title: string): void
}>()

const query = ref('')

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

  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (isSameDay(date, yesterday)) {
    const label = rtf ? capitalize(rtf.format(-1, 'day')) : 'Yesterday'
    return `${label}, ${time}`
  }

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
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-header">
      <h1>Noteapp</h1>
      <button class="create-fab" @click="emit('create')" aria-label="Opret ny note">+</button>
    </div>

    <div class="search-wrap">
      <input
        v-model="query"
        class="search-input"
        type="search"
        placeholder="Søg i noter..."
        @keydown="onKeydown" />
      <button v-if="query" class="search-clear" aria-label="Ryd søgning" @click="clearQuery">✕</button>
    </div>

    <div class="list">
      <button
        v-for="item in filteredNotes"
        :key="item.note.title"
        class="note-item"
        :class="{ active: item.note.title === selectedTitle }"
        @click="emit('select', item.note.title)">
        <div>
          <strong>{{ item.note.title }}</strong>
          <small>{{ formatUpdatedAt(item.note.updatedAt) }}</small>
          <small v-if="item.snippet" class="snippet">{{ item.snippet }}</small>
        </div>
        <span
          class="pin"
          :aria-label="pinned.has(item.note.title) ? 'Fjern stjerne' : 'Stjernemarkér note'"
          @click.stop="emit('toggle-pin', item.note.title)">{{ pinned.has(item.note.title) ? '★' : '☆' }}</span>
      </button>
    </div>
  </aside>
</template>
